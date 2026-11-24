/** matter.js 0.18 ServerNode 실행 adapter(T032/T033/T034). */
import type {MatterNetworkConfig} from "./networkConfig";
import type {DynamicEndpointAdapter} from "./dynamicEndpoints";
import type {EndpointRegistryEntry} from "./endpointRegistry";

export interface MatterServerNode {
    start(): Promise<void>;
    close(): Promise<void>;
    add(endpoint: unknown): Promise<unknown>;
}

export interface MatterMainModule {
    ServerNode: {
        create(rootEndpoint: unknown, options: Record<string, unknown>): Promise<MatterServerNode>;
        RootEndpoint?: unknown;
        RootEndpointWithoutGroupcast?: unknown;
    };
    Endpoint?: new (definition: unknown, options?: Record<string, unknown>) => unknown;
    VendorId?: (value: number) => unknown;
}

export interface MatterNodeOptions {
    readonly id: string;
    readonly network?: MatterNetworkConfig;
    readonly passcode?: number;
    readonly discriminator?: number;
    readonly vendorId?: number;
    readonly productId?: number;
    readonly productName?: string;
}

export interface MatterEndpointFactory {
    create(entry: EndpointRegistryEntry): Promise<{endpoint: unknown}>;
    readAssignedNumber(entry: EndpointRegistryEntry, endpoint: unknown, added: unknown): number;
    remove(entry: EndpointRegistryEntry): Promise<void>;
}

export class MatterSdkEndpointAdapter implements DynamicEndpointAdapter {
    constructor(
        private readonly runtime: MatterSdkRuntime,
        private readonly factory: MatterEndpointFactory,
    ) {}

    async create(entry: EndpointRegistryEntry): Promise<{number: number}> {
        const created = await this.factory.create(entry);
        const added = await this.runtime.addEndpoint(created.endpoint);

        return {number: this.factory.readAssignedNumber(entry, created.endpoint, added)};
    }

    async remove(entry: EndpointRegistryEntry): Promise<void> {
        await this.factory.remove(entry);
    }
}

export class MatterSdkRuntime {
    private module?: MatterMainModule;
    private node?: MatterServerNode;

    async load(): Promise<MatterMainModule> {
        if (this.module) return this.module;
        const moduleName: string = "@matter/main";
        try {
            this.module = (await import(moduleName)) as unknown as MatterMainModule;
        } catch (error) {
            throw new Error(`Matter SDK '${moduleName}' is not installed or cannot be loaded: ${(error as Error).message}`);
        }
        if (!this.module.ServerNode?.create) throw new Error("Matter SDK does not expose ServerNode.create");
        return this.module;
    }

    async createNode(options: MatterNodeOptions): Promise<MatterServerNode> {
        if (!options.id) throw new Error("Matter node id is required");
        const sdk = await this.load();
        const commissioning = options.passcode === undefined || options.discriminator === undefined
            ? undefined
            : {passcode: options.passcode, discriminator: options.discriminator};
        const basicInformation = options.vendorId === undefined || options.productId === undefined
            ? undefined
            : {
                  vendorId: sdk.VendorId ? sdk.VendorId(options.vendorId) : options.vendorId,
                  productId: options.productId,
                  productName: options.productName ?? "Zigbee2Matter Bridge",
                  nodeLabel: options.productName ?? "Zigbee2Matter Bridge",
                  serialNumber: options.id,
              };
        const rootEndpoint = sdk.ServerNode.RootEndpoint ?? sdk.ServerNode.RootEndpointWithoutGroupcast;
        if (rootEndpoint === undefined) throw new Error("Matter SDK does not expose a root endpoint");
        const node = await sdk.ServerNode.create(rootEndpoint, {
            id: options.id,
            ...(options.network ? {network: options.network} : {}),
            ...(commissioning ? {commissioning} : {}),
            ...(basicInformation ? {basicInformation} : {}),
        });
        this.node = node;
        return node;
    }

    async addEndpoint(endpoint: unknown): Promise<unknown> {
        if (!this.node) throw new Error("Matter node has not been created");
        return await this.node.add(endpoint);
    }

    async start(): Promise<void> {
        if (!this.node) throw new Error("Matter node has not been created");
        await this.node.start();
    }

    async stop(): Promise<void> {
        if (!this.node) return;
        await this.node.close();
        this.node = undefined;
    }

    get currentNode(): MatterServerNode | undefined {
        return this.node;
    }
}
