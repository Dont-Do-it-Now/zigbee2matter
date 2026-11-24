/**
 * 복수 Matter 브리지의 격리·주소 충돌 정책(T038).
 *
 * 실제 SDK node 생성은 주입되는 `BridgeNodeRuntimeFactory`가 담당한다(기본 구현: sdkRuntime.ts `MatterSdkBridgeNodeRuntimeFactory`).
 * 명시적 제약: SDK의 mdns 네트워크 설정(MATTER_MDNS_NETWORKINTERFACE/IPV4)과 `storage.path`는 프로세스 전역이다.
 * 한 프로세스에서 실행하는 브리지는 같은 mDNS interface/ipv4/storage 루트를 공유해야 하고, 서로 다른 interface가 필요하면 프로세스를 분리한다.
 * 브리지별 격리는 port, discriminator, mDNS instance, SDK node id(= fabricStoreKey 저장소 네임스페이스)로 보장한다.
 */

export interface BridgeNodeConfig {
    readonly bridgeId: string;
    readonly fabricStoreKey: string;
    readonly port: number;
    readonly mdnsInstance: string;
    readonly discriminator: number;
}

export type BridgeNodeStatus = "starting" | "running" | "failed" | "stopped";

export interface BridgeNodeState extends BridgeNodeConfig {
    status: BridgeNodeStatus;
    error?: string;
}

export interface BridgeNodeRuntime {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface BridgeNodeRuntimeFactory {
    create(config: BridgeNodeConfig): BridgeNodeRuntime;
}

export class MultiBridgeRegistry {
    private readonly nodes = new Map<string, BridgeNodeState>();

    register(config: BridgeNodeConfig): BridgeNodeState {
        if (!config.bridgeId || !config.fabricStoreKey || !config.mdnsInstance) throw new Error("bridge identity is required");
        if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("invalid bridge port");
        if (!Number.isSafeInteger(config.discriminator) || config.discriminator < 0 || config.discriminator > 4095)
            throw new Error("invalid bridge discriminator");
        if (this.nodes.has(config.bridgeId)) throw new Error(`bridge already registered: ${config.bridgeId}`);
        if ([...this.nodes.values()].some((node) => node.port === config.port)) throw new Error(`bridge port already used: ${config.port}`);
        if ([...this.nodes.values()].some((node) => node.fabricStoreKey === config.fabricStoreKey))
            throw new Error(`fabric store already used: ${config.fabricStoreKey}`);
        if ([...this.nodes.values()].some((node) => node.mdnsInstance === config.mdnsInstance))
            throw new Error(`mDNS instance already used: ${config.mdnsInstance}`);
        if ([...this.nodes.values()].some((node) => node.discriminator === config.discriminator))
            throw new Error(`discriminator already used: ${config.discriminator}`);
        const state: BridgeNodeState = {...config, status: "stopped"};
        this.nodes.set(config.bridgeId, state);
        return {...state};
    }

    transition(bridgeId: string, status: BridgeNodeStatus, error?: string): BridgeNodeState {
        const node = this.nodes.get(bridgeId);
        if (!node) throw new Error(`unknown bridge: ${bridgeId}`);
        if (!isAllowedTransition(node.status, status)) throw new Error(`invalid bridge transition: ${node.status} -> ${status}`);
        node.status = status;
        node.error = error;
        return {...node};
    }

    get(bridgeId: string): BridgeNodeState | undefined {
        const node = this.nodes.get(bridgeId);
        return node && {...node};
    }

    list(): BridgeNodeState[] {
        return [...this.nodes.values()].map((node) => ({...node}));
    }

    unregister(bridgeId: string): boolean {
        const node = this.nodes.get(bridgeId);
        if (!node) return false;
        if (node.status === "starting" || node.status === "running") throw new Error("running bridge must be stopped before removal");
        return this.nodes.delete(bridgeId);
    }
}

/** Registry 상태와 브리지별 node runtime을 묶어 한 브리지의 실패가 다른 브리지에 전파되지 않게 한다. */
export class MultiBridgeRuntime {
    private readonly runtimes = new Map<string, BridgeNodeRuntime>();

    constructor(
        private readonly registry: MultiBridgeRegistry,
        private readonly factory: BridgeNodeRuntimeFactory,
    ) {}

    async start(config: BridgeNodeConfig): Promise<BridgeNodeState> {
        const existing = this.registry.get(config.bridgeId);
        if (existing === undefined) {
            this.registry.register(config);
        } else {
            if (existing.status !== "failed") throw new Error(`bridge already registered: ${config.bridgeId}`);
            if (!sameConfig(existing, config)) throw new Error(`bridge configuration changed after failure: ${config.bridgeId}`);
        }
        this.registry.transition(config.bridgeId, "starting");

        try {
            const runtime = this.factory.create(config);
            await runtime.start();
            this.runtimes.set(config.bridgeId, runtime);
            return this.registry.transition(config.bridgeId, "running");
        } catch (error) {
            this.registry.transition(config.bridgeId, "failed", error instanceof Error ? error.message : "bridge start failed");
            throw error;
        }
    }

    async stop(bridgeId: string): Promise<BridgeNodeState> {
        const runtime = this.runtimes.get(bridgeId);
        if (!runtime) {
            const state = this.registry.get(bridgeId);
            if (!state) throw new Error(`unknown bridge: ${bridgeId}`);
            if (state.status === "stopped") return state;
            throw new Error(`bridge runtime is unavailable: ${bridgeId}`);
        }

        await runtime.stop();
        this.runtimes.delete(bridgeId);
        return this.registry.transition(bridgeId, "stopped");
    }

    async stopAll(): Promise<void> {
        for (const bridgeId of [...this.runtimes.keys()]) await this.stop(bridgeId);
    }

    get(bridgeId: string): BridgeNodeRuntime | undefined {
        return this.runtimes.get(bridgeId);
    }
}

function isAllowedTransition(from: BridgeNodeStatus, to: BridgeNodeStatus): boolean {
    if (from === to) return true;
    if (from === "stopped") return to === "starting";
    if (from === "starting") return to === "running" || to === "failed" || to === "stopped";
    if (from === "running") return to === "failed" || to === "stopped";
    return to === "stopped" || to === "starting";
}

function sameConfig(a: BridgeNodeConfig, b: BridgeNodeConfig): boolean {
    return (
        a.bridgeId === b.bridgeId &&
        a.fabricStoreKey === b.fabricStoreKey &&
        a.port === b.port &&
        a.mdnsInstance === b.mdnsInstance &&
        a.discriminator === b.discriminator
    );
}
