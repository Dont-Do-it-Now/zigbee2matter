/** Core·EventStream·API·Matter adapter를 묶는 composition root(T032/T053/T056/T057). */
import {ApiAuth, type AuthOptions, type TokenRecord} from "../api/auth";
import {DiagnosticRegistry} from "../api/diagnostics";
import {AuthFailureRateLimiter} from "../api/rateLimit";
import {ApiServer, type ApiServerOptions} from "../api/server";
import type EventBus from "../eventBus";
import {EventStream} from "../events";
import PlatformFanout, {type Platform, type PlatformFanoutOptions, type PlatformListener} from "../events/fanout";
import type {BridgeId} from "../identity";
import ServiceLifecycle from "../lifecycle";
import {CommissioningManager} from "../matter/commissioning";
import {type DynamicEndpointAdapter, DynamicEndpointCoordinator, DynamicEndpointRuntime} from "../matter/dynamicEndpoints";
import {EndpointRegistry, type EndpointRegistryOptions, type RegistryKey} from "../matter/endpointRegistry";
import {FileEndpointRegistryStore} from "../matter/endpointRegistryStore";
import {type BridgeNodeRuntimeFactory, MultiBridgeRegistry, MultiBridgeRuntime} from "../matter/multiBridge";
import {
    type MatterEndpointFactory,
    type MatterFabricStore,
    type MatterNodeOptions,
    MatterSdkEndpointAdapter,
    MatterSdkRuntime,
} from "../matter/sdkRuntime";
import StateReconciler from "../state/reconciliation";
import StateSnapshotCoordinator from "../state/snapshot";
import type {PersistentSnapshot} from "../storage/backup";
import {BackupFileStore} from "../storage/backupStore";
import data from "../util/data";
import {
    assertRestoreApplied,
    assertSnapshotProvider,
    type BackupSnapshotAdapter,
    type BackupSnapshotProvider,
    validateSnapshotParts,
} from "./backupRestore";

export type {BackupSnapshotAdapter, BackupSnapshotProvider} from "./backupRestore";

export interface BridgeRuntimeOptions {
    readonly eventCapacity?: number;
    readonly matterEndpointFactory?: MatterEndpointFactory;
    readonly matterFabricStore?: MatterFabricStore;
    readonly commissioning?: CommissioningManager;
    /**
     * 복수 브리지(T038). 프로덕션 composition root가 factory를 주입한다(예: MatterSdkBridgeNodeRuntimeFactory).
     * 제약: SDK mdns 네트워크 설정(MATTER_MDNS_*)과 storage.path는 프로세스 전역이라 한 프로세스의 브리지는 같은 값을 공유한다.
     */
    readonly multiBridge?: {
        readonly registry?: MultiBridgeRegistry;
        readonly factory: BridgeNodeRuntimeFactory;
    };
    readonly backup?: {
        readonly store?: BackupFileStore;
        readonly snapshotProvider?: BackupSnapshotProvider;
        readonly snapshotAdapter?: BackupSnapshotAdapter;
    };
    readonly auth?: AuthOptions;
    readonly initialTokens?: readonly TokenRecord[];
    readonly api?: Omit<ApiServerOptions, "auth" | "stream" | "listDiagnostics" | "authFailureRateLimiter">;
}

export class BridgeRuntime {
    readonly events: EventStream;
    readonly auth: ApiAuth;
    readonly diagnostics: DiagnosticRegistry;
    readonly fanout: PlatformFanout;
    readonly matter: MatterSdkRuntime;
    readonly stateReconciler: StateReconciler;
    readonly stateSnapshots: StateSnapshotCoordinator;
    readonly lifecycle: ServiceLifecycle;
    readonly commissioning: CommissioningManager;
    readonly multiBridge?: MultiBridgeRuntime;
    private readonly api?: ApiServer;
    private readonly matterEndpointFactory?: MatterEndpointFactory;
    private dynamicEndpointRuntime?: DynamicEndpointRuntime;
    private sdkEndpointAdapter?: MatterSdkEndpointAdapter;
    private readonly backupStore: BackupFileStore;
    private readonly backupSnapshotProvider?: BackupSnapshotProvider;
    private readonly backupSnapshotAdapter?: BackupSnapshotAdapter;
    private endpointRegistry?: EndpointRegistry;
    private attachedEventBus?: EventBus;

    constructor(options: BridgeRuntimeOptions = {}) {
        this.events = new EventStream(options.eventCapacity);
        this.auth = new ApiAuth(options.auth, options.initialTokens);
        this.diagnostics = new DiagnosticRegistry();
        this.fanout = new PlatformFanout(this.events);
        this.matter = new MatterSdkRuntime(undefined, options.matterFabricStore);
        this.stateReconciler = new StateReconciler();
        this.stateSnapshots = new StateSnapshotCoordinator(this.stateReconciler, this.events);
        this.lifecycle = new ServiceLifecycle();
        this.commissioning = options.commissioning ?? new CommissioningManager({backend: this.matter.commissioningBackend()});
        this.multiBridge = options.multiBridge
            ? new MultiBridgeRuntime(options.multiBridge.registry ?? new MultiBridgeRegistry(), options.multiBridge.factory)
            : undefined;
        this.matterEndpointFactory = options.matterEndpointFactory;
        this.backupStore = options.backup?.store ?? new BackupFileStore();
        this.backupSnapshotProvider = options.backup?.snapshotProvider;
        this.backupSnapshotAdapter = options.backup?.snapshotAdapter;
        if (options.api) {
            const limiter = new AuthFailureRateLimiter();
            this.api = new ApiServer({
                ...options.api,
                auth: this.auth,
                stream: this.events,
                listDiagnostics: () => this.diagnostics.snapshot(),
                authFailureRateLimiter: limiter,
            });
        }
    }

    attachEventBus(eventBus: EventBus): void {
        if (this.attachedEventBus) throw new Error("BridgeRuntime is already attached to an EventBus");
        this.events.attach(eventBus);
        this.attachedEventBus = eventBus;
    }

    subscribePlatform(id: string, platform: Platform, listener: PlatformListener, options: PlatformFanoutOptions = {}): () => void {
        this.diagnostics.record(id, platform, {queued: 0, dropped: 0, errors: 0});
        return this.fanout.subscribe(id, platform, listener, {
            ...options,
            onDrop: (drop) => {
                options.onDrop?.(drop);
                const stats = this.fanout.stats(id);
                if (stats) this.diagnostics.record(id, platform, stats, undefined, `dropped ${drop.reason} event`);
            },
            onError: (error, consumer) => {
                options.onError?.(error, consumer);
                const stats = this.fanout.stats(id);
                if (stats) this.diagnostics.record(id, platform, stats, undefined, error);
            },
        });
    }

    /**
     * T022: matter/api는 서로 격리된다. 한쪽 시작이 실패해도 다른 쪽과 Zigbee는 계속 동작하며, 실패는 반환값과 diagnostics로 보고한다.
     */
    async start(): Promise<readonly {readonly name: "matter" | "api"; readonly error: unknown}[]> {
        const failures: {name: "matter" | "api"; error: unknown}[] = [];
        const components: {name: string; start: () => Promise<void>; stop: () => Promise<void>}[] = [];
        const isolate = (name: "matter" | "api", platform: Platform, start: () => Promise<void>, stop: () => Promise<void>): void => {
            let started = false;
            components.push({
                name,
                start: async () => {
                    try {
                        await start();
                        started = true;
                    } catch (error) {
                        failures.push({name, error});
                        this.diagnostics.record(`service-${name}`, platform, {queued: 0, dropped: 0, errors: 1}, undefined, error);
                        try {
                            await stop();
                        } catch {
                            // The original start failure is the one reported.
                        }
                    }
                },
                stop: async () => {
                    if (started) await stop();
                },
            });
        };
        if (this.matter.currentNode)
            isolate(
                "matter",
                "matter",
                () => this.matter.start(),
                () => this.matter.stop(),
            );
        const api = this.api;
        if (api)
            isolate(
                "api",
                "http",
                () => api.start(),
                () => api.stop(),
            );
        await this.lifecycle.start(components);

        return failures;
    }

    async startMatter(options: MatterNodeOptions): Promise<void> {
        if (!this.endpointRegistry) {
            throw new Error("endpoint registry must be opened before starting Matter");
        }
        if (!this.matterEndpointFactory) {
            throw new Error("Matter endpoint factory is not configured");
        }

        // D4: SDK fabric/키 저장소를 `<ZIGBEE2MATTER_DATA>/matter/storage` 하위로 고정한다(컨테이너 재생성 시 fabric 보존).
        await this.matter.createNode({storagePath: data.joinPath("matter/storage"), ...options});
        this.dynamicEndpointRuntime = this.createSdkDynamicEndpointRuntime(this.matterEndpointFactory);
    }

    async openEndpointRegistry(bridgeId: BridgeId, options: EndpointRegistryOptions = {}): Promise<EndpointRegistry> {
        if (this.endpointRegistry) {
            if (this.endpointRegistry.bridgeId !== bridgeId) throw new Error("BridgeRuntime endpoint registry identity mismatch");
            return this.endpointRegistry;
        }

        this.endpointRegistry = await EndpointRegistry.open(bridgeId, new FileEndpointRegistryStore(), options);
        return this.endpointRegistry;
    }

    get currentEndpointRegistry(): EndpointRegistry | undefined {
        return this.endpointRegistry;
    }

    createDynamicEndpointRuntime(adapter: DynamicEndpointAdapter): DynamicEndpointRuntime {
        if (!this.endpointRegistry) {
            throw new Error("endpoint registry must be opened before creating dynamic endpoint runtime");
        }

        return new DynamicEndpointRuntime(new DynamicEndpointCoordinator(this.endpointRegistry), adapter);
    }

    createSdkDynamicEndpointRuntime(factory: MatterEndpointFactory): DynamicEndpointRuntime {
        const adapter = new MatterSdkEndpointAdapter(this.matter, factory);
        this.sdkEndpointAdapter = adapter;

        return this.createDynamicEndpointRuntime(adapter);
    }

    /** Matter로 노출하지 못한 expose 공급자(API 연결용). Matter 시작 전에는 undefined. */
    get unsupportedFeatures(): MatterSdkEndpointAdapter | undefined {
        return this.sdkEndpointAdapter;
    }

    get currentDynamicEndpointRuntime(): DynamicEndpointRuntime | undefined {
        return this.dynamicEndpointRuntime;
    }

    async updateMatterEndpoint(key: RegistryKey, state: Record<string, unknown>): Promise<void> {
        const entry = this.endpointRegistry?.get(key);
        if (!entry) return;
        await this.matterEndpointFactory?.updateState?.(entry, state);
    }

    async createPersistentBackup(passphrase: string): Promise<void> {
        if (!this.endpointRegistry) throw new Error("endpoint registry must be opened before creating a backup");
        const provider = this.backupSnapshotProvider;
        assertSnapshotProvider(provider);

        const snapshot: PersistentSnapshot = {
            schema: "zigbee2matter.snapshot",
            version: 1,
            identity: await provider.identity(),
            fabric: await provider.fabric(),
            endpointRegistry: this.endpointRegistry.serialize(),
            ...(provider.zigbee ? {zigbee: await provider.zigbee()} : {}),
        };
        validateSnapshotParts(snapshot.identity, snapshot.fabric, snapshot.endpointRegistry);
        await this.backupStore.writeSnapshot(snapshot, passphrase);
    }

    async restorePersistentBackup(passphrase: string): Promise<PersistentSnapshot> {
        return await this.backupStore.readSnapshotWith(passphrase, async (snapshot) => {
            validateSnapshotParts(snapshot.identity, snapshot.fabric, snapshot.endpointRegistry);
            if (!this.backupSnapshotAdapter) throw new Error("backup restore adapter is not configured");

            const result = await this.backupSnapshotAdapter.restore(snapshot);
            assertRestoreApplied(result);
            return snapshot;
        });
    }

    async stop(): Promise<void> {
        let firstError: unknown;

        try {
            await this.lifecycle.stop();
        } catch (error) {
            firstError = error;
        }
        this.dynamicEndpointRuntime = undefined;
        this.sdkEndpointAdapter = undefined;
        if (this.attachedEventBus) {
            this.events.detach(this.attachedEventBus);
            this.attachedEventBus = undefined;
        }

        if (firstError !== undefined) {
            throw firstError;
        }
    }

    /** API가 시작은 됐지만 일부 기능이 제한된 사유(없으면 undefined). */
    get apiDegradedReason(): string | undefined {
        return this.api?.degradedReason;
    }

    get apiAddress(): ReturnType<ApiServer["address"]> | undefined {
        return this.api?.address();
    }
}
