/** matter.js 0.18 ServerNode 실행 adapter(T032/T033/T034). */
import {readFile} from "node:fs/promises";
import {toMatterEnvVars, toServerNodeNetworkState, type MatterNetworkConfig} from "./networkConfig";
import type {ResolvedAttestation} from "./attestation";
import type {DynamicEndpointAdapter} from "./dynamicEndpoints";
import type {EndpointRegistryEntry} from "./endpointRegistry";
import {MatterReportingRuntime, type MatterReportingAdapter} from "./reporting";

export type {MatterReportingAdapter} from "./reporting";

export interface MatterServerNode {
    start(): Promise<void>;
    close(): Promise<void>;
    add(endpoint: unknown): Promise<unknown>;
}

interface MatterEndpointContainer {
    add(endpoint: unknown): Promise<unknown>;
}

export interface MatterMainModule {
    ServerNode: {
        create(options: Record<string, unknown>): Promise<MatterServerNode>;
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
    remove(entry: EndpointRegistryEntry): Promise<void | {permanent: boolean}>;
    updateState?(entry: EndpointRegistryEntry, state: Record<string, unknown>): Promise<void>;
}

/** SDK-owned fabric/key-store persistence boundary. The runtime never serializes SDK internals itself. */
export interface MatterFabricStore {
    snapshot(): unknown | Promise<unknown>;
    restore(snapshot: unknown): void | Promise<void>;
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

    async remove(entry: EndpointRegistryEntry): Promise<void | {permanent: boolean}> {
        return await this.factory.remove(entry);
    }
}

export class MatterSdkRuntime {
    readonly reporting: MatterReportingRuntime;
    private module?: MatterMainModule;
    private node?: MatterServerNode;
    private endpointContainer?: MatterEndpointContainer;
    private nodeId?: string;
    private started = false;
    private appliedEnvironment?: MatterEnvironment;
    private appliedEnvironmentNames: string[] = [];

    constructor(
        private readonly environment: MatterEnvironment = processMatterEnvironment,
        private readonly fabricStore?: MatterFabricStore,
        reportingAdapter?: MatterReportingAdapter,
    ) {
        this.reporting = new MatterReportingRuntime(reportingAdapter);
    }

    async snapshotFabric(): Promise<unknown> {
        if (!this.fabricStore) throw new Error("Matter fabric store is not configured");

        return await this.fabricStore.snapshot();
    }

    async restoreFabric(snapshot: unknown): Promise<void> {
        if (!this.fabricStore) throw new Error("Matter fabric store is not configured");

        await this.fabricStore.restore(snapshot);
    }

    async load(): Promise<MatterMainModule> {
        if (this.module) return this.module;
        const moduleName: string = "@matter/main";
        try {
            const loaded = (await import(moduleName)) as unknown as MatterMainModule;
            if (!loaded.ServerNode?.create) throw new Error("Matter SDK does not expose ServerNode.create");
            this.module = loaded;
        } catch (error) {
            throw new Error(`Matter SDK '${moduleName}' is not installed or cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
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
            const node = await sdk.ServerNode.create({
                id: options.id,
                ...(options.network ? {network: toServerNodeNetworkState(options.network)} : {}),
                ...(commissioning ? {commissioning} : {}),
                ...(basicInformation ? {basicInformation} : {}),
                ...(customCertification ? {operationalCredentials: customCertification} : {}),
            });
            try {
                if (!sdk.Endpoint) throw new Error("Matter SDK does not expose Endpoint");
                const {AggregatorEndpoint} = await import("@matter/main/endpoints/aggregator");
                this.endpointContainer = new sdk.Endpoint(AggregatorEndpoint, {id: "aggregator"}) as MatterEndpointContainer;
                await node.add(this.endpointContainer);
            } catch (error) {
                this.endpointContainer = undefined;
                try {
                    await node.close();
                } catch {
                    // Preserve the original endpoint setup error.
                }
                throw error;
            }
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
        if (!this.node || !this.endpointContainer) throw new Error("Matter node has not been created");
        return await this.endpointContainer.add(endpoint);
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
            this.endpointContainer = undefined;
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
function processEnvironmentName(name: string): string {
    if (name === "mdns.networkInterface") return "MATTER_MDNS_NETWORKINTERFACE";
    if (name === "mdns.ipv4") return "MATTER_MDNS_IPV4";
    throw new Error(`unsupported Matter environment variable '${name}'`);
}

const processMatterEnvironment: MatterEnvironment = {
    set(name, value): void {
        const processName = processEnvironmentName(name);
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
        const processName = processEnvironmentName(name);
        const current = processEnvironmentState.get(processName);
        if (!current) return;
        current.owners -= 1;
        if (current.owners > 0) return;
        if (current.previous === undefined) delete process.env[processName];
        else process.env[processName] = current.previous;
        processEnvironmentState.delete(processName);
    },
};
