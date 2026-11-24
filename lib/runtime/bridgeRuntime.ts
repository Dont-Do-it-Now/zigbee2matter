/** Core·EventStream·API·Matter adapter를 묶는 composition root(T032/T053/T056/T057). */
import type EventBus from "../eventBus";
import {EventStream} from "../events";
import {ApiAuth, type AuthOptions, type Principal, type TokenRecord} from "../api/auth";
import {ApiServer, type ApiServerOptions} from "../api/server";
import {AuthFailureRateLimiter} from "../api/rateLimit";
import {DiagnosticRegistry} from "../api/diagnostics";
import {MatterSdkEndpointAdapter, MatterSdkRuntime, type MatterEndpointFactory, type MatterNodeOptions} from "../matter/sdkRuntime";
import {DynamicEndpointCoordinator, DynamicEndpointRuntime, type DynamicEndpointAdapter} from "../matter/dynamicEndpoints";
import type {RestDevice, RestRouterDeps} from "../api/restRouter";
import type {WsSnapshot} from "../api/wsSession";
import {EndpointRegistry, type EndpointRegistryOptions} from "../matter/endpointRegistry";
import {FileEndpointRegistryStore} from "../matter/endpointRegistryStore";
import type {BridgeId} from "../identity";
import {BackupFileStore} from "../storage/backupStore";
import type {PersistentSnapshot} from "../storage/backup";
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
    readonly matter: MatterSdkRuntime;
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
        this.matter = new MatterSdkRuntime();
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

    async start(): Promise<void> {
        await this.api?.start();
    }

    async startMatter(options: MatterNodeOptions): Promise<void> {
        if (!this.endpointRegistry) {
            throw new Error("endpoint registry must be opened before starting Matter");
        }

        await this.matter.createNode(options);
        if (this.matterEndpointFactory) {
            this.dynamicEndpointRuntime = this.createSdkDynamicEndpointRuntime(this.matterEndpointFactory);
        }
        await this.matter.start();
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
            identity: provider.identity(),
            fabric: provider.fabric(),
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
            await this.api?.stop();
        } catch (error) {
            firstError = error;
        }

        try {
            await this.matter.stop();
        } catch (error) {
            firstError ??= error;
        } finally {
            this.dynamicEndpointRuntime = undefined;
            if (this.attachedEventBus) {
                this.events.detach(this.attachedEventBus);
                this.attachedEventBus = undefined;
            }
        }

        if (firstError !== undefined) {
            throw firstError;
        }
    }

    get apiAddress(): ReturnType<ApiServer["address"]> | undefined {
        return this.api?.address();
    }
}
