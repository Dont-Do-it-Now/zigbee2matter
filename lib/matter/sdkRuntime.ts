/** matter.js 0.18 ServerNode 실행 adapter(T032/T033/T034). */
import {readFile} from "node:fs/promises";
import type {ResolvedAttestation} from "./attestation";
import type {CommissioningBackend, CommissioningCode, FabricChangeAction, FabricRecord} from "./commissioning";
import type {DynamicEndpointAdapter} from "./dynamicEndpoints";
import type {EndpointRegistryEntry} from "./endpointRegistry";
import type {BridgeNodeConfig, BridgeNodeRuntime, BridgeNodeRuntimeFactory} from "./multiBridge";
import {type MatterNetworkConfig, toMatterEnvVars, toServerNodeNetworkState} from "./networkConfig";
import type {FeatureDecision} from "./unsupportedFeatures";

/**
 * 구독/보고(T040)는 SDK가 소유한다. 상태는 `endpoint.set(...)`(MatterEndpointFactory.updateState)로만 갱신하고,
 * SDK가 구독자에게 보고한다. 이 파일에 자체 구독 구현을 두지 않는다.
 */

export interface MatterServerNode {
    start(): Promise<void>;
    close(): Promise<void>;
    add(endpoint: unknown): Promise<unknown>;
    /** SDK Environment. `get(Class)`로 FabricManager/DeviceCommissioner 같은 서비스를 얻는다. */
    readonly env?: {get(type: unknown): unknown};
    readonly events?: {
        readonly commissioning?: {
            readonly fabricsChanged?: {
                on(observer: (fabricIndex: number, action: FabricChangeAction) => void): void;
                off(observer: (fabricIndex: number, action: FabricChangeAction) => void): void;
            };
        };
    };
    readonly state?: {
        readonly operationalCredentials?: {readonly supportedFabrics?: number};
        readonly commissioning?: {
            readonly discriminator: number;
            readonly commissioned?: boolean;
            readonly pairingCodes?: {readonly manualPairingCode: string; readonly qrPairingCode: string};
            readonly fabrics?: Readonly<Record<string, SdkFabricInformation>>;
        };
    };
}

/** @matter/protocol ExposedFabricInformation 중 사용하는 필드. */
interface SdkFabricInformation {
    readonly fabricIndex: number;
    readonly fabricId: bigint | number;
    readonly nodeId: bigint | number;
    readonly rootVendorId: number;
    readonly label: string;
}

/** `@matter/main/protocol`에서 사용하는 export만 선언한다. */
interface MatterProtocolModule {
    DeviceCommissioner: unknown;
    FabricManager: unknown;
}

interface SdkDeviceCommissioner {
    readonly windowStatus: number;
    allowBasicCommissioning(options?: {timeout?: unknown}): Promise<void>;
    endCommissioning(): Promise<void>;
}

interface SdkFabricManager {
    maybeFor(identifier: {fabricIndex: number}): {delete(): Promise<void>} | undefined;
}

/** AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen (@matter/types d.ts). */
const WINDOW_NOT_OPEN = 0;

interface MatterEndpointContainer {
    add(endpoint: unknown): Promise<unknown>;
}

export interface MatterMainModule {
    ServerNode: {
        create(options: Record<string, unknown>): Promise<MatterServerNode>;
    };
    Endpoint?: new (definition: unknown, options?: Record<string, unknown>) => unknown;
    VendorId?: (value: number) => unknown;
    /** @matter/general `Millis` TimeUnit factory. */
    Millis?: (value: number) => unknown;
    /** SDK 기본 Environment. `vars.set("storage.path", ...)`로 저장소 위치를 지정한다. */
    Environment?: {readonly default: {readonly vars: {set(name: string, value: string | boolean | number): void}}};
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
    /**
     * SDK(fabric/키/endpoint number) 저장 루트. `<ZIGBEE2MATTER_DATA>/matter/...` 하위를 지정한다(D4).
     * 프로세스 전역 SDK 변수 `storage.path`이므로 같은 프로세스의 모든 node가 같은 값을 써야 한다(node별 분리는 node id 네임스페이스).
     */
    readonly storagePath?: string;
}

export interface MatterEnvironment {
    set(name: string, value: string | boolean): void;
    unset(name: string): void;
}

/** endpoint별로 Matter에 노출하지 못한 expose 목록 공급자(API 연결은 통합 단계). */
export interface UnsupportedFeatureProvider {
    unsupportedFor(endpointId: string): readonly FeatureDecision[];
}

export interface MatterEndpointFactory {
    create(entry: EndpointRegistryEntry): Promise<{endpoint: unknown; unsupported?: readonly FeatureDecision[]}>;
    readAssignedNumber(entry: EndpointRegistryEntry, endpoint: unknown, added: unknown): number;
    remove(entry: EndpointRegistryEntry): Promise<undefined | {permanent: boolean}>;
    updateState?(entry: EndpointRegistryEntry, state: Record<string, unknown>): Promise<void>;
    /** Applies a renamed friendly name to the live bridged endpoint (all fabrics see it via attribute reporting). */
    updateLabel?(entry: EndpointRegistryEntry, name: string): Promise<void>;
    /** True when the live endpoint no longer matches the Matter device type/clusters derived from current exposes. */
    hasPlanChanged?(entry: EndpointRegistryEntry): Promise<boolean>;
}

/** SDK-owned fabric/key-store persistence boundary. The runtime never serializes SDK internals itself. */
export interface MatterFabricStore {
    snapshot(): unknown | Promise<unknown>;
    restore(snapshot: unknown): void | Promise<void>;
}

export class MatterSdkEndpointAdapter implements DynamicEndpointAdapter, UnsupportedFeatureProvider {
    private readonly unsupported = new Map<string, readonly FeatureDecision[]>();

    constructor(
        private readonly runtime: MatterSdkRuntime,
        private readonly factory: MatterEndpointFactory,
    ) {}

    async create(entry: EndpointRegistryEntry): Promise<{number: number}> {
        const created = await this.factory.create(entry);
        try {
            const added = await this.runtime.addEndpoint(created.endpoint);
            this.unsupported.set(entry.endpointId, created.unsupported ?? []);

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

    unsupportedFor(endpointId: string): readonly FeatureDecision[] {
        return this.unsupported.get(endpointId) ?? [];
    }

    async remove(entry: EndpointRegistryEntry): Promise<undefined | {permanent: boolean}> {
        this.unsupported.delete(entry.endpointId);

        return await this.factory.remove(entry);
    }
}

export class MatterSdkRuntime {
    private module?: MatterMainModule;
    private protocol?: MatterProtocolModule;
    private node?: MatterServerNode;
    private endpointContainer?: MatterEndpointContainer;
    private nodeId?: string;
    private started = false;
    private appliedEnvironment?: MatterEnvironment;
    private appliedEnvironmentNames: string[] = [];

    constructor(
        private readonly environment: MatterEnvironment = processMatterEnvironment,
        private readonly fabricStore?: MatterFabricStore,
    ) {}

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
            throw new Error(
                `Matter SDK '${moduleName}' is not installed or cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return this.module;
    }

    async createNode(options: MatterNodeOptions): Promise<MatterServerNode> {
        if (!options.id) throw new Error("Matter node id is required");
        if (this.node) throw new Error(`Matter node '${this.nodeId ?? "unknown"}' has already been created`);
        if (
            options.attestation !== undefined &&
            (options.vendorId !== options.attestation.vendorId || options.productId !== options.attestation.productId)
        ) {
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
            this.protocol ??= await loadProtocol();
            if (options.storagePath !== undefined) applyStoragePath(sdk, options.storagePath);
            const commissioning =
                options.passcode === undefined || options.discriminator === undefined
                    ? undefined
                    : {passcode: options.passcode, discriminator: options.discriminator};
            const basicInformation =
                options.vendorId === undefined || options.productId === undefined
                    ? undefined
                    : {
                          vendorId: sdk.VendorId ? sdk.VendorId(options.vendorId) : options.vendorId,
                          productId: options.productId,
                          productName: options.productName ?? "Zigbee2Matter Bridge",
                          nodeLabel: options.productName ?? "Zigbee2Matter Bridge",
                          serialNumber: options.id,
                      };
            const customCertification =
                options.attestation?.useSdkGeneratedTestCertification === false
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

    getCommissioningCode(): CommissioningCode {
        const commissioning = this.node?.state?.commissioning;
        const setupCode = commissioning?.pairingCodes?.manualPairingCode;
        const qrCode = commissioning?.pairingCodes?.qrPairingCode;
        if (setupCode === undefined || qrCode === undefined || commissioning === undefined) {
            throw new Error("Matter commissioning code is not available before the SDK node is created");
        }

        return {setupCode, qrCode, discriminator: commissioning.discriminator};
    }

    /**
     * T033/T034: 등록 창과 fabric 상태를 SDK에 위임하는 backend. 호출 시점의 현재 node를 사용한다.
     * 창 열기 = DeviceCommissioner.allowBasicCommissioning, 닫기 = endCommissioning,
     * fabric 목록 = node.state.commissioning.fabrics, 제거 = FabricManager fabric.delete(),
     * 이벤트 = node.events.commissioning.fabricsChanged.
     */
    commissioningBackend(): CommissioningBackend {
        return {
            openWindow: async (durationMs) => {
                const sdk = this.module;
                if (!sdk?.Millis) throw new Error("Matter SDK does not expose Millis");
                await this.commissioner().allowBasicCommissioning({timeout: sdk.Millis(durationMs)});

                return this.getCommissioningCode();
            },
            closeWindow: async () => {
                if (this.node === undefined || this.protocol === undefined) return false;
                const commissioner = this.commissioner();
                if (commissioner.windowStatus === WINDOW_NOT_OPEN) return false;
                await commissioner.endCommissioning();

                return true;
            },
            isWindowOpen: () => {
                if (this.node === undefined || this.protocol === undefined) return false;

                return this.commissioner().windowStatus !== WINDOW_NOT_OPEN;
            },
            listFabrics: () => this.listSdkFabrics(),
            removeFabric: async (fabricIndex) => {
                const fabric = this.fabricManager().maybeFor({fabricIndex});
                if (!fabric) return false;
                await fabric.delete();

                return true;
            },
            onFabricsChanged: (listener) => {
                const observable = this.node?.events?.commissioning?.fabricsChanged;
                if (!observable) return () => {};
                observable.on(listener);

                return () => observable.off(listener);
            },
        };
    }

    private listSdkFabrics(): FabricRecord[] {
        const fabrics = this.node?.state?.commissioning?.fabrics;
        if (!fabrics) return [];

        return Object.values(fabrics).map((fabric) => ({
            fabricIndex: Number(fabric.fabricIndex),
            fabricId: String(fabric.fabricId),
            nodeId: String(fabric.nodeId),
            rootVendorId: Number(fabric.rootVendorId),
            label: fabric.label,
        }));
    }

    private commissioner(): SdkDeviceCommissioner {
        return this.sdkService<SdkDeviceCommissioner>("DeviceCommissioner");
    }

    private fabricManager(): SdkFabricManager {
        return this.sdkService<SdkFabricManager>("FabricManager");
    }

    private sdkService<T>(name: keyof MatterProtocolModule): T {
        const env = this.node?.env;
        const type = this.protocol?.[name];
        if (!env || type === undefined) throw new Error("Matter node has not been created");

        return env.get(type) as T;
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

async function loadProtocol(): Promise<MatterProtocolModule> {
    const moduleName: string = "@matter/main/protocol";
    try {
        const loaded = (await import(moduleName)) as unknown as MatterProtocolModule;
        if (!loaded.DeviceCommissioner || !loaded.FabricManager) {
            throw new Error("Matter SDK protocol module lacks DeviceCommissioner/FabricManager");
        }

        return loaded;
    } catch (error) {
        throw new Error(`Matter SDK '${moduleName}' cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** SDK `storage.path`는 프로세스 전역이다. 다른 값으로 재지정하면 기존 node의 fabric 저장소와 섞이므로 거부한다. */
let appliedStoragePath: string | undefined;
function applyStoragePath(sdk: MatterMainModule, storagePath: string): void {
    if (!storagePath) throw new Error("Matter storagePath must not be empty");
    if (appliedStoragePath !== undefined && appliedStoragePath !== storagePath) {
        throw new Error("Matter SDK storage path is process-global and already set to a different value");
    }
    if (!sdk.Environment) throw new Error("Matter SDK does not expose Environment");
    sdk.Environment.default.vars.set("storage.path", storagePath);
    appliedStoragePath = storagePath;
}

export interface MatterSdkBridgeNodeOptions {
    readonly passcode: number;
    readonly vendorId?: number;
    readonly productId?: number;
    readonly productName?: string;
    readonly network?: MatterNetworkConfig;
    readonly storagePath?: string;
    readonly environment?: MatterEnvironment;
    /** 테스트/주입용. 기본은 브리지마다 새 MatterSdkRuntime. */
    readonly runtimeFactory?: () => MatterSdkRuntime;
}

/**
 * T038: MultiBridgeRuntime용 SDK 기반 factory. 브리지마다 독립 MatterSdkRuntime/ServerNode를 만들고
 * node id = fabricStoreKey(SDK 저장소 네임스페이스), port/discriminator는 BridgeNodeConfig를 사용한다.
 *
 * 제약(SDK 프로세스 전역): `mdns.networkInterface`/`mdns.ipv4`(MATTER_MDNS_* env)와 `storage.path`는 프로세스당 하나다.
 * 같은 프로세스의 브리지들은 같은 값을 공유해야 하며 다르면 start가 실패한다(다른 NIC가 필요하면 별도 프로세스).
 * Zigbee endpoint 연결(aggregator part 추가)은 이 factory 범위 밖이다. 호출자가 반환 runtime을 통해 구성해야 한다.
 */
export class MatterSdkBridgeNodeRuntimeFactory implements BridgeNodeRuntimeFactory {
    constructor(private readonly options: MatterSdkBridgeNodeOptions) {}

    create(config: BridgeNodeConfig): BridgeNodeRuntime {
        const runtime = this.options.runtimeFactory?.() ?? new MatterSdkRuntime(this.options.environment);
        const options = this.options;

        return {
            async start(): Promise<void> {
                await runtime.createNode({
                    id: config.fabricStoreKey,
                    network: {...options.network, port: config.port},
                    passcode: options.passcode,
                    discriminator: config.discriminator,
                    ...(options.productName !== undefined ? {productName: options.productName} : {}),
                    ...(options.vendorId !== undefined ? {vendorId: options.vendorId} : {}),
                    ...(options.productId !== undefined ? {productId: options.productId} : {}),
                    ...(options.storagePath !== undefined ? {storagePath: options.storagePath} : {}),
                });
                await runtime.start();
            },
            async stop(): Promise<void> {
                await runtime.stop();
            },
        };
    }
}
