/** matter.js 0.18 ServerNode 실행 adapter(T032/T033/T034). */
import {readFile} from "node:fs/promises";
import {toMatterEnvVars, toServerNodeNetworkState, type MatterNetworkConfig} from "./networkConfig";
import type {ResolvedAttestation} from "./attestation";
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
    readonly attestation?: ResolvedAttestation;
    readonly environment?: MatterEnvironment;
}

export interface MatterEnvironment {
    set(name: string, value: string | boolean): void;
    unset(name: string): void;
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
        try {
            const added = await this.runtime.addEndpoint(created.endpoint);

            return {number: this.factory.readAssignedNumber(entry, created.endpoint, added)};
        } catch (error) {
            try {
                await this.factory.remove(entry);
            } catch {
                // Preserve the original SDK/addition error; diagnostics own cleanup reporting.
            }
            throw error;
        }
    }

    async remove(entry: EndpointRegistryEntry): Promise<void> {
        await this.factory.remove(entry);
    }
}

export class MatterSdkRuntime {
    private module?: MatterMainModule;
    private node?: MatterServerNode;
    private nodeId?: string;
    private started = false;
    private appliedEnvironment?: MatterEnvironment;
    private appliedEnvironmentNames: string[] = [];

    constructor(private readonly environment: MatterEnvironment = processMatterEnvironment) {}

    async load(): Promise<MatterMainModule> {
        if (this.module) return this.module;
        const moduleName: string = "@matter/main";
        try {
            const loaded = (await import(moduleName)) as unknown as MatterMainModule;
            if (!loaded.ServerNode?.create) throw new Error("Matter SDK does not expose ServerNode.create");
            this.module = loaded;
        } catch (error) {
            throw new Error(`Matter SDK '${moduleName}' is not installed or cannot be loaded: ${(error as Error).message}`);
        }
        return this.module;
    }

    async createNode(options: MatterNodeOptions): Promise<MatterServerNode> {
        if (!options.id) throw new Error("Matter node id is required");
        if (this.node) throw new Error(`Matter node '${this.nodeId ?? "unknown"}' has already been created`);
        if (options.attestation !== undefined && (options.vendorId !== options.attestation.vendorId || options.productId !== options.attestation.productId)) {
            throw new Error("Matter attestation VID/PID must match basic information");
        }
        if ((options.passcode === undefined) !== (options.discriminator === undefined)) {
            throw new Error("Matter passcode and discriminator must be provided together");
        }
        const environment = options.environment ?? this.environment;
        const environmentVars = toMatterEnvVars(options.network ?? {});
        const appliedEnvironmentNames: string[] = [];

        try {
            for (const [name, value] of Object.entries(environmentVars)) {
                environment.set(name, value);
                appliedEnvironmentNames.push(name);
            }
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
            const customCertification = options.attestation?.useSdkGeneratedTestCertification === false
                ? {
                      certification: async () => {
                          const files = options.attestation?.files;
                          if (!files) throw new Error("Matter custom attestation files are missing");
                          try {
                              return {
                                  privateKey: await readFile(files.dacPrivateKey),
                                  certificate: await readFile(files.dac),
                                  intermediateCertificate: await readFile(files.pai),
                                  declaration: await readFile(files.cd),
                              };
                          } catch {
                              throw new Error("Matter custom attestation files could not be loaded");
                          }
                      },
                  }
                : undefined;
            const rootEndpoint = sdk.ServerNode.RootEndpoint ?? sdk.ServerNode.RootEndpointWithoutGroupcast;
            if (rootEndpoint === undefined) throw new Error("Matter SDK does not expose a root endpoint");
            const node = await sdk.ServerNode.create(rootEndpoint, {
                id: options.id,
                ...(options.network ? {network: toServerNodeNetworkState(options.network)} : {}),
                ...(commissioning ? {commissioning} : {}),
                ...(basicInformation ? {basicInformation} : {}),
                ...(customCertification ? {operationalCredentials: customCertification} : {}),
            });
            this.node = node;
            this.nodeId = options.id;
            this.started = false;
            this.appliedEnvironment = environment;
            this.appliedEnvironmentNames = appliedEnvironmentNames;
            return node;
        } catch (error) {
            for (const name of appliedEnvironmentNames) environment.unset(name);
            throw error;
        }
    }

    async addEndpoint(endpoint: unknown): Promise<unknown> {
        if (!this.node) throw new Error("Matter node has not been created");
        return await this.node.add(endpoint);
    }

    async start(): Promise<void> {
        if (!this.node) throw new Error("Matter node has not been created");
        if (this.started) return;
        await this.node.start();
        this.started = true;
    }

    async stop(): Promise<void> {
        if (!this.node) return;
        try {
            await this.node.close();
        } finally {
            this.node = undefined;
            this.nodeId = undefined;
            this.started = false;
            this.clearAppliedEnvironment();
        }
    }

    get currentNode(): MatterServerNode | undefined {
        return this.node;
    }

    private clearAppliedEnvironment(): void {
        if (!this.appliedEnvironment) return;
        for (const name of this.appliedEnvironmentNames) this.appliedEnvironment.unset(name);
        this.appliedEnvironment = undefined;
        this.appliedEnvironmentNames = [];
    }
}

interface ProcessEnvironmentState {
    previous: string | undefined;
    value: string;
    owners: number;
}

const processEnvironmentState = new Map<string, ProcessEnvironmentState>();
const processMatterEnvironment: MatterEnvironment = {
    set(name, value): void {
        const processName = name === "mdns.networkInterface" ? "MATTER_MDNS_NETWORKINTERFACE" : "MATTER_MDNS_IPV4";
        const nextValue = String(value);
        const current = processEnvironmentState.get(processName);
        if (current) {
            if (current.value !== nextValue) throw new Error(`Matter environment '${processName}' is already set to a different value`);
            current.owners += 1;
            return;
        }

        processEnvironmentState.set(processName, {previous: process.env[processName], value: nextValue, owners: 1});
        process.env[processName] = nextValue;
    },
    unset(name): void {
        const processName = name === "mdns.networkInterface" ? "MATTER_MDNS_NETWORKINTERFACE" : "MATTER_MDNS_IPV4";
        const current = processEnvironmentState.get(processName);
        if (!current) return;
        current.owners -= 1;
        if (current.owners > 0) return;
        if (current.previous === undefined) delete process.env[processName];
        else process.env[processName] = current.previous;
        processEnvironmentState.delete(processName);
    },
};
