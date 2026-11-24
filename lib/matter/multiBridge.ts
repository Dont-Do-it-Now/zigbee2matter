/** 복수 Matter 브리지의 격리·주소 충돌 정책(T038). */

export interface BridgeNodeConfig {
    readonly bridgeId: string;
    readonly fabricStoreKey: string;
    readonly port: number;
    readonly mdnsInstance: string;
}

export type BridgeNodeStatus = "starting" | "running" | "failed" | "stopped";

export interface BridgeNodeState extends BridgeNodeConfig {
    status: BridgeNodeStatus;
    error?: string;
}

export class MultiBridgeRegistry {
    private readonly nodes = new Map<string, BridgeNodeState>();

    register(config: BridgeNodeConfig): BridgeNodeState {
        if (!config.bridgeId || !config.fabricStoreKey || !config.mdnsInstance) throw new Error("bridge identity is required");
        if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("invalid bridge port");
        if (this.nodes.has(config.bridgeId)) throw new Error(`bridge already registered: ${config.bridgeId}`);
        if ([...this.nodes.values()].some((node) => node.port === config.port)) throw new Error(`bridge port already used: ${config.port}`);
        if ([...this.nodes.values()].some((node) => node.fabricStoreKey === config.fabricStoreKey)) throw new Error(`fabric store already used: ${config.fabricStoreKey}`);
        const state: BridgeNodeState = {...config, status: "stopped"};
        this.nodes.set(config.bridgeId, state);
        return {...state};
    }

    transition(bridgeId: string, status: BridgeNodeStatus, error?: string): BridgeNodeState {
        const node = this.nodes.get(bridgeId);
        if (!node) throw new Error(`unknown bridge: ${bridgeId}`);
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
}
