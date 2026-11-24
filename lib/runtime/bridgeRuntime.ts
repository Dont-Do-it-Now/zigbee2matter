/** Core·EventStream·API·Matter adapter를 묶는 composition root(T032/T053/T056/T057). */
import type EventBus from "../eventBus";
import {EventStream} from "../events";
import PlatformFanout, {type Platform, type PlatformFanoutOptions, type PlatformListener} from "../events/fanout";
import {ApiAuth, type AuthOptions, type Principal, type TokenRecord} from "../api/auth";
import {ApiServer, type ApiServerOptions} from "../api/server";
import {AuthFailureRateLimiter} from "../api/rateLimit";
import {DiagnosticRegistry} from "../api/diagnostics";
import {MatterSdkEndpointAdapter, MatterSdkRuntime, type MatterEndpointFactory, type MatterFabricStore, type MatterNodeOptions} from "../matter/sdkRuntime";
import {DynamicEndpointCoordinator, DynamicEndpointRuntime, type DynamicEndpointAdapter} from "../matter/dynamicEndpoints";
import type {RestDevice, RestRouterDeps} from "../api/restRouter";
import type {WsSnapshot} from "../api/wsSession";
import {EndpointRegistry, type EndpointRegistryOptions} from "../matter/endpointRegistry";
import {FileEndpointRegistryStore} from "../matter/endpointRegistryStore";
import type {BridgeId} from "../identity";
import {BackupFileStore} from "../storage/backupStore";
import type {PersistentSnapshot} from "../storage/backup";
import StateReconciler from "../state/reconciliation";
import StateSnapshotCoordinator from "../state/snapshot";
import ServiceLifecycle from "../lifecycle";
import {CommissioningManager} from "../matter/commissioning";
import {MultiBridgeRegistry, MultiBridgeRuntime, type BridgeNodeRuntimeFactory} from "../matter/multiBridge";
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
    readonly api?: Omit<ApiServerOptions, "auth" | "stream" | "listDevices" | "listDiagnostics" | "authFailureRateLimiter" | keyof RestRouterDeps> & {
        readonly listDevices: () => readonly RestDevice[];
        readonly snapshot?: () => WsSnapshot;
        readonly executeCommand?: (input: unknown, principal: Principal) => Promise<unknown>;
        readonly tls?: {readonly certPath: string; readonly keyPath: string};
    };
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
        this.commissioning = options.commissioning ?? new CommissioningManager();
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

    async start(): Promise<void> {
        const components = [];
        if (this.matter.currentNode) {
            components.push({name: "matter", start: () => this.matter.start(), stop: () => this.matter.stop()});
        }
        if (this.api) {
            components.push({name: "api", start: () => this.api!.start(), stop: () => this.api!.stop()});
        }
        await this.lifecycle.start(components);
    }

    async startMatter(options: MatterNodeOptions): Promise<void> {
        if (!this.endpointRegistry) {
            throw new Error("endpoint registry must be opened before starting Matter");
        }
        if (!this.matterEndpointFactory) {
            throw new Error("Matter endpoint factory is not configured");
        }

        await this.matter.createNode(options);
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
        return this.createDynamicEndpointRuntime(new MatterSdkEndpointAdapter(this.matter, factory));
    }

    get currentDynamicEndpointRuntime(): DynamicEndpointRuntime | undefined {
        return this.dynamicEndpointRuntime;
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
        };
        validateSnapshotParts(snapshot.identity, snapshot.fabric, snapshot.endpointRegistry);
        await this.backupStore.writeSnapshot(snapshot, passphrase);
    }

    async restorePersistentBackup(passphrase: string): Promise<PersistentSnapshot> {
        const snapshot = await this.backupStore.readSnapshot(passphrase);
        validateSnapshotParts(snapshot.identity, snapshot.fabric, snapshot.endpointRegistry);
        if (!this.backupSnapshotAdapter) throw new Error("backup restore adapter is not configured");

        const result = await this.backupSnapshotAdapter.restore(snapshot);
        assertRestoreApplied(result);
        return snapshot;
    }

    async stop(): Promise<void> {
        let firstError: unknown;

        try {
            await this.lifecycle.stop();
        } catch (error) {
            firstError = error;
        }
        this.dynamicEndpointRuntime = undefined;
        if (this.attachedEventBus) {
            this.events.detach(this.attachedEventBus);
            this.attachedEventBus = undefined;
        }

        if (firstError !== undefined) {
            throw firstError;
        }
    }

    get apiAddress(): ReturnType<ApiServer["address"]> | undefined {
        return this.api?.address();
    }
}
