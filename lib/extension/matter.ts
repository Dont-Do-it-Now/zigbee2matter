/**
 * z2m-fork: T009/O4 Matter 연결 Extension (composition root).
 *
 * Matter/API/runtime/명령 조립은 upstream Controller가 아니라 이 Extension이 소유한다. Core(controller, eventBus, state, zigbee)는
 * lib/matter를 import하지 않는다(C5). Matter/API 시작 실패는 해당 서비스만 degraded 처리하고 Zigbee 프로세스는 종료하지 않는다(T022).
 */
import {randomUUID} from "node:crypto";
import {rm} from "node:fs/promises";
import {InterviewState} from "zigbee-herdsman/dist/controller/model/device";
import {ApiError, assessTransport, type Principal} from "../api/auth";
import {HaHybridPolicy} from "../api/haHybrid";
import {CallbackHaIntegrationAdapter, type HaCommand, HaIntegrationRouter} from "../api/haIntegration";
import type {RestBridge, RestDevice, RestGroup, RestSettingsProvider, RestUnsupportedFeatureProvider, SettingsKind} from "../api/restRouter";
import {FileApiTokenStore} from "../api/tokenStore";
import {BASE_TOPIC} from "../bridgeBus/constants";
import type {BridgeBus} from "../bridgeBus/types";
import CommandDeduplicator from "../command/deduplication";
import CommandLoopGuard from "../command/loopGuard";
import {authorizeByScope} from "../command/permissions";
import DeviceCommandQueue from "../command/queue";
import CommandRetryPolicy from "../command/retry";
import CommandRouter from "../command/router";
import type {Command, CommandResult, ResolvedTarget, TargetResolver} from "../command/types";
import type EventBus from "../eventBus";
import type {BridgeEvent} from "../events";
import {HaBridge, mapDeviceExposes} from "../ha";
import {
    type BridgeId,
    bindingMatches,
    deviceKeyOf,
    FileBridgeIdentityStore,
    FileNetworkIdentityStore,
    formatDeviceKey,
    formatGroupKey,
    generateBridgeId,
    generateNetworkId,
    groupKeyOf,
    makeDeviceKey,
    type NetworkIdentity,
    parseEntityKey,
    toHerdsmanIeee,
} from "../identity";
import {DEFAULT_VENDOR_ID, resolveAttestation} from "../matter/attestation";
import type {CommissioningManager, FabricChangeAction} from "../matter/commissioning";
import type {DynamicEndpointRuntime} from "../matter/dynamicEndpoints";
import type {EndpointRegistryDocument, EndpointRegistryEntry, RegistryKey} from "../matter/endpointRegistry";
import {FileMatterFabricStore} from "../matter/fabricStore";
import {type MappingExpose, planEndpointMapping} from "../matter/mappingRegistry";
import {diagnoseMatterNetwork, selectMatterMdnsInterface} from "../matter/networkConfig";
import {type MatterEndpointFactory, type MatterFabricStore, MatterSdkBridgeNodeRuntimeFactory} from "../matter/sdkRuntime";
import {ZigbeeMatterEndpointFactory} from "../matter/zigbeeEndpointFactory";
import {type MigrationOperationsInput, runMigrationOperations} from "../migration/operations";
import {BridgeRuntime} from "../runtime";
import type State from "../state";
import {isFileSet, readNamedFileSet, validateFileSet, writeFileSet} from "../storage/fileSet";
import data from "../util/data";
import logger from "../util/logger";
import * as settings from "../util/settings";
import utils from "../util/utils";
import type Zigbee from "../zigbee";
import ExposesValueValidator from "./commandValidator";
import Extension from "./extension";
import ExtensionOTAUpdate from "./otaUpdate";

export interface MatterExtensionOptions {
    readonly matterEndpointFactory?: MatterEndpointFactory;
    readonly matterFabricStore?: MatterFabricStore;
    readonly commissioning?: CommissioningManager;
}

/** T013 큐 한도. 코디네이터 처리량 대비 보수적인 값이며 초과 시 BUSY로 종결된다. */
export const COMMAND_QUEUE_MAX_PENDING = 256;
export const COMMAND_QUEUE_MAX_CONCURRENT = 16;

const ACTION_KEY = /^action(_|$)/;
const MATTER_CONSUMER = "matter-endpoints";
const HA_CONSUMER = "ha-matter";
/** 백업에 포함하는 Zigbee 필수 데이터(네트워크 키는 configuration.yaml/secret.yaml/coordinator_backup.json에 있다). */
const ZIGBEE_BACKUP_FILES = ["database.db", "coordinator_backup.json", "configuration.yaml", "secret.yaml", "state.json"];
const RETRY_SUFFIX = /:r\d+$/;
/** Backoff before each retry of a failed Matter endpoint removal (bounded: attempts = length + 1). */
const REMOVE_RETRY_DELAYS_MS = [500, 2000, 5000];
/** Matter spec minimum for commissioned fabrics; the SDK-reported limit is preferred when available. */
const DEFAULT_MAX_FABRICS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Message plus nested `cause`/`errors` (matter.js aggregates per-behavior failures), e.g. "A (errors: B (cause: C))". */
function errorChain(error: unknown, depth = 0): string {
    const message = errorMessage(error);
    if (!(error instanceof Error) || depth > 5) return message;
    const nested: string[] = [];
    if (error.cause !== undefined) nested.push(`cause: ${errorChain(error.cause, depth + 1)}`);
    const errors = (error as {errors?: unknown}).errors;
    if (Array.isArray(errors)) for (const e of errors) nested.push(`errors: ${errorChain(e, depth + 1)}`);

    return nested.length > 0 ? `${message} (${nested.join("; ")})` : message;
}

function isUnmappable(error: unknown): boolean {
    return errorMessage(error).includes("no approved capability");
}

function stateForEndpoint(state: Record<string, unknown>, ...suffixes: Array<string | undefined>): Record<string, unknown> {
    const scoped = {...state};
    for (const suffix of suffixes) {
        if (!suffix) continue;
        const marker = `_${suffix}`;
        for (const [key, value] of Object.entries(state)) {
            if (key.endsWith(marker)) scoped[key.slice(0, -marker.length)] = value;
        }
    }

    return scoped;
}

/** 버튼 `action`류는 순간 이벤트이므로 상태(캐시/snapshot)에 병합하지 않는다. */
function splitActions(state: Record<string, unknown>): {state: Record<string, unknown>; actions: Record<string, unknown>} {
    const rest: Record<string, unknown> = {};
    const actions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
        if (ACTION_KEY.test(key)) actions[key] = value;
        else rest[key] = value;
    }

    return {state: rest, actions};
}

function formatExtendedPanId(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return `0x${value.map((byte: number) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (typeof value === "number" || typeof value === "bigint") return `0x${value.toString(16).padStart(16, "0")}`;

    return undefined;
}

export default class Matter extends Extension {
    public readonly runtime: BridgeRuntime;
    public readonly ha: HaIntegrationRouter;
    public readonly haHybrid: HaHybridPolicy;
    public readonly haBridge: HaBridge;
    /** 생성 시점에는 I/O 없는 임시 값이며, start()에서 저장소의 실제 값으로 교체된다. 교체 실패 시 임시 값 유지 + Matter 차단. */
    public networkIdentity: NetworkIdentity = {networkId: generateNetworkId()};
    public bridgeIdentity: BridgeId = generateBridgeId();
    private matterVendorId = DEFAULT_VENDOR_ID;
    /** 시작에 실패했거나 정책으로 차단된 서비스. Zigbee는 계속 동작한다(T022). */
    public readonly degraded = new Map<"matter" | "api" | "registry", string>();
    private readonly networkIdentityStore = new FileNetworkIdentityStore();
    private readonly commandRouter: CommandRouter;
    private readonly commandDeduplicator = new CommandDeduplicator();
    private readonly commandQueue: DeviceCommandQueue;
    private readonly intents = new Map<string, {desired: boolean; targets: readonly {key: string; value: Record<string, unknown>}[]}>();
    private readonly fileFabricStore?: FileMatterFabricStore;
    private readonly startupFailures: {name: "matter" | "api" | "registry"; error: unknown}[] = [];
    /** identity 로드 전에는 임시 networkId 키가 만들어지지 않도록 상태/가용성/endpoint 이벤트를 무시한다. */
    private identityReady = false;
    private matterBlocked: string | undefined;
    private readonly endpointFactory: MatterEndpointFactory;
    /** Per-endpoint write slots: while a write is in flight, newer values merge into `pending` (last-write-wins). */
    private readonly matterWrites = new Map<string, {pending?: Record<string, unknown>}>();
    /** Serializes create/remove/rebuild/relabel per device so rapid events cannot interleave. */
    private readonly deviceOps = new Map<string, Promise<void>>();

    constructor(
        zigbee: Zigbee,
        bridgeBus: BridgeBus,
        state: State,
        publishEntityState: PublishEntityState,
        eventBus: EventBus,
        enableDisableExtension: (enable: boolean, name: string) => Promise<void>,
        restartCallback: () => Promise<void>,
        addExtension: (extension: Extension) => Promise<void>,
        private readonly options: MatterExtensionOptions,
        private readonly getExtension: (name: string) => Extension | undefined,
    ) {
        super(zigbee, bridgeBus, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension);

        // 생성자는 설정 보관만 한다. 실패는 startupFailures에 기록하고 start()에서 해당 서비스만 degraded 처리한다(T022).
        const apiSettings = settings.get().api;
        let apiEnabled = apiSettings.enabled;
        if (apiEnabled && !assessTransport(apiSettings).secure) {
            this.startupFailures.push({name: "api", error: new Error("API requires TLS for non-loopback binding")});
            apiEnabled = false;
        }

        const apiTokenStore = new FileApiTokenStore(data.joinPath("api-tokens.json"), (message) => logger.warning(message));
        let initialTokens: ReturnType<FileApiTokenStore["load"]> = [];
        try {
            initialTokens = apiTokenStore.load();
        } catch (error) {
            this.startupFailures.push({name: "api", error});
            apiEnabled = false;
        }

        const matterEndpointFactory =
            options.matterEndpointFactory ??
            new ZigbeeMatterEndpointFactory({
                loadSdk: () => this.runtime.matter.load(),
                resolve: (entry) => Promise.resolve(this.resolveMatterEndpointSource(entry)),
                onCommandError: (endpointId, error) => {
                    logger.warning(`Matter command delivery failed for ${endpointId}: ${errorMessage(error)}`);
                },
            });

        this.endpointFactory = matterEndpointFactory;
        const matterSettings = settings.get().matter;
        // T061/T062: 주입이 없으면 SDK storage 디렉터리를 파일 단위로 snapshot하는 기본 store를 쓴다.
        if (!options.matterFabricStore) this.fileFabricStore = new FileMatterFabricStore(data.joinPath("matter/storage"));
        const build = (withApi: boolean): BridgeRuntime =>
            new BridgeRuntime({
                matterEndpointFactory,
                matterFabricStore: options.matterFabricStore ?? this.fileFabricStore,
                commissioning: options.commissioning,
                ...(matterSettings.passcode !== undefined
                    ? {
                          multiBridge: {
                              factory: new MatterSdkBridgeNodeRuntimeFactory({
                                  passcode: matterSettings.passcode,
                                  ...(matterSettings.network ? {network: matterSettings.network} : {}),
                                  storagePath: data.joinPath("matter/storage"),
                              }),
                          },
                      }
                    : {}),
                backup: {
                    snapshotProvider: {
                        identity: () => ({...this.networkIdentity, bridgeId: this.bridgeIdentity}),
                        fabric: () => this.runtime.matter.snapshotFabric(),
                        zigbee: () => readNamedFileSet(data.getPath(), ZIGBEE_BACKUP_FILES),
                    },
                    snapshotAdapter: {restore: (snapshot) => this.restoreSnapshot(snapshot)},
                },
                auth: {
                    legacyToken: apiSettings.auth_token,
                    onChange: (records) => apiTokenStore.save(records),
                },
                initialTokens,
                api: withApi
                    ? {
                          host: apiSettings.host,
                          port: apiSettings.port,
                          ...(apiSettings.ssl_cert || apiSettings.ssl_key
                              ? {tls: {certPath: apiSettings.ssl_cert ?? "", keyPath: apiSettings.ssl_key ?? ""}}
                              : {}),
                          listDevices: () => this.listRestDevices(),
                          listGroups: () => this.listRestGroups(),
                          listJobs: () => this.listRestJobs(),
                          listBridges: () => this.listRestBridges(),
                          settings: this.restSettings(),
                          unsupportedFeatures: this.restUnsupportedFeatures(),
                          executeCommand: (input, principal) => this.executeRestCommand(input, principal),
                          runMigration: (input) => this.runMigration(input),
                          backup: {
                              create: (passphrase) => this.createPersistentBackup(passphrase),
                              restore: (passphrase) => this.restorePersistentBackup(passphrase),
                          },
                          matterManagement: {
                              commissioningWindow: () => this.runtime.commissioning.getActiveWindow(),
                              openCommissioningWindow: (input) => this.openCommissioningWindow(input),
                              closeCommissioningWindow: () => this.runtime.commissioning.closeWindow(),
                              listFabrics: () => this.runtime.commissioning.listFabrics(),
                              removeFabric: (fabricIndex) => this.runtime.commissioning.removeFabric(fabricIndex),
                              listEndpoints: () => this.runtime.currentEndpointRegistry?.list() ?? [],
                          },
                          // T021: 요청자에게만 보내는 조회이므로 스트림에 snapshot 이벤트를 발행하지 않는다.
                          snapshot: () => {
                              const snapshot = this.runtime.stateSnapshots.peek();

                              return {
                                  epoch: snapshot.epoch,
                                  sequence: snapshot.watermark,
                                  payload: {records: snapshot.records, revision: snapshot.revision},
                              };
                          },
                      }
                    : undefined,
            });
        try {
            this.runtime = build(apiEnabled);
        } catch (error) {
            // 예: TLS cert/key 읽기 실패. API 없이 다시 만들어 Zigbee/Matter는 계속 기동한다.
            if (!apiEnabled) throw error;
            this.startupFailures.push({name: "api", error});
            this.runtime = build(false);
        }

        this.ha = new HaIntegrationRouter();
        this.haHybrid = new HaHybridPolicy();
        const haCommand = (command: HaCommand): Promise<void> => this.executeHaCommand(command);
        this.ha.add(new CallbackHaIntegrationAdapter("direct", {onCommand: haCommand}));
        this.ha.add(new CallbackHaIntegrationAdapter("matter", {onCommand: haCommand}));
        this.ha.connect("direct", {onCommand: haCommand});
        this.ha.connect("matter", {onCommand: haCommand});
        this.haHybrid.connect({onCommand: (mode, command) => this.ha.send(mode, command)});
        this.haBridge = new HaBridge(this.ha, {hybrid: this.haHybrid});

        // T016/T017: 상태 소비자는 fanout을 거친다. 드롭되면 fanout이 snapshot(resync) 신호를 보낸다.
        this.runtime.events.setNetworkId(this.networkIdentity.networkId);
        this.runtime.subscribePlatform(HA_CONSUMER, "matter", (event) => this.onHaEvent(event));
        this.runtime.subscribePlatform(MATTER_CONSUMER, "matter", (event) => this.onMatterEvent(event));
        this.runtime.attachEventBus(this.eventBus);

        const resolver: TargetResolver = {resolve: (target) => this.resolveCommandTarget(target)};
        this.commandQueue = new DeviceCommandQueue({
            keyResolver: (command) => this.commandQueueKeys(command),
            maxPending: COMMAND_QUEUE_MAX_PENDING,
            maxConcurrent: COMMAND_QUEUE_MAX_CONCURRENT,
        });
        const commandLoopGuard = new CommandLoopGuard({
            onRepeat: (diagnosis) => {
                this.runtime.events.publish("transient", "command/loop", diagnosis, {correlationId: diagnosis.correlationId});
            },
        });
        this.commandRouter = new CommandRouter({
            eventBus: this.eventBus,
            bridgeBus: this.bridgeBus,
            resolver,
            authorizer: {authorize: (command) => authorizeByScope(command)},
            validator: new ExposesValueValidator(this.zigbee),
            retryPolicy: new CommandRetryPolicy(),
            loopGuard: commandLoopGuard,
            hooks: {
                admit: this.commandDeduplicator.admit,
                schedule: this.commandQueue.schedule,
                onDispatched: (command) => this.commandQueue.onDispatched(command.requestId),
                onResult: (result) => this.onCommandResult(result),
            },
        });

        // 상태 이벤트 구독(구 Controller 생성자). Zigbee 시작 직후의 이벤트도 놓치지 않도록 생성 시점에 건다.
        this.eventBus.onStateChange(this, (change) => this.onStateChange(change));
        this.eventBus.onBridgeBusMessagePublished(this, (published) => this.onAvailabilityPublished(published));
        this.eventBus.onDeviceInterview(this, (interview) => {
            if (interview.status === "successful" && this.identityReady) {
                this.syncHaDevice(interview.device);
                if (this.shouldExposeMatterDevice(interview.device)) {
                    void this.syncMatterEndpoints(interview.device, true).then(() => this.syncHaDevice(interview.device));
                }
            }
        });
        this.eventBus.onExposesChanged(this, (changed) => {
            this.syncHaDevice(changed.device);
            if (this.identityReady) void this.rebuildMatterEndpoints(changed.device).then(() => this.syncHaDevice(changed.device));
        });
        this.eventBus.onEntityRenamed(this, (renamed) => {
            const device = renamed.entity;
            if (!this.identityReady || !device.isDevice()) return;
            this.syncHaDevice(device);
            const firstFriendlyName = renamed.from === device.ieeeAddr;
            const updateMatter = firstFriendlyName
                ? this.syncMatterEndpoints(device, true).then(() => this.relabelMatterEndpoints(device, renamed.to))
                : this.relabelMatterEndpoints(device, renamed.to);
            void updateMatter;
        });
        this.eventBus.onEntityRemoved(this, (removed) => {
            if (!this.identityReady) return;
            for (const state of this.stateSnapshotsForEntity(removed.entity)) {
                this.runtime.stateSnapshots.remove(state.key);
            }
            if (removed.entity.isDevice()) {
                this.haBridge.removeDevice(removed.entity.ID);
                void this.syncMatterEndpoints(removed.entity, false);
            }
        });
    }

    override async start(): Promise<void> {
        // 순서: 명령 라우터 -> 신원 검사 -> endpoint registry/Matter -> API. 다른 extension이 모두 시작된 뒤 호출되므로 초기 명령이 유실되지 않는다(T022).
        for (const failure of this.startupFailures) {
            this.degrade(failure.name, failure.error, `${failure.name} initialization failed; Zigbee keeps running`);
        }
        this.commandQueue.start();
        this.commandRouter.start();

        try {
            this.networkIdentity = this.networkIdentityStore.getOrCreate();
            this.bridgeIdentity = new FileBridgeIdentityStore().getOrCreate();
            this.runtime.events.setNetworkId(this.networkIdentity.networkId);
        } catch (error) {
            // 임시 identity로 endpoint key를 영속하면 안 되므로 Matter/registry만 차단한다.
            this.degrade("registry", error, "Identity store failed; Matter is disabled");
            this.matterBlocked ??= "identity unavailable";
        }

        this.identityReady = true;
        this.seedSnapshots();

        if (this.matterBlocked === undefined) await this.verifyNetworkBinding();

        try {
            if (this.matterBlocked === undefined) await this.runtime.openEndpointRegistry(this.bridgeIdentity);
        } catch (error) {
            this.degrade("registry", error, "Endpoint registry failed to open; Matter is disabled");
            this.matterBlocked ??= "endpoint registry unavailable";
        }

        if (settings.get().matter.enabled && this.matterBlocked === undefined) {
            try {
                await this.startMatter();
            } catch (error) {
                this.degrade("matter", error, "Matter failed to start; Zigbee and API keep running");
            }
        } else if (settings.get().matter.enabled) {
            this.degrade("matter", new Error(this.matterBlocked ?? "blocked"), "Matter is blocked");
        }

        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) this.syncHaDevice(device);

        try {
            for (const failure of await this.runtime.start()) {
                this.degrade(failure.name, failure.error, `${failure.name} failed to start; Zigbee keeps running`);
            }
            const apiReason = this.runtime.apiDegradedReason;
            if (apiReason !== undefined && !this.degraded.has("api")) {
                this.degrade("api", new Error(apiReason), "API started in degraded mode; Zigbee and Matter keep running");
            }
        } catch (error) {
            this.degrade("api", error, "Bridge runtime failed to start; Zigbee keeps running");
        }
    }

    override async stop(): Promise<void> {
        // 첫 단계에서 lifecycle gate를 닫아(phase stopping) 이후 명령은 UNAVAILABLE이 된다.
        try {
            await this.runtime.stop();
        } finally {
            this.commandQueue.stop();
            this.commandRouter.stop();
            await super.stop();
        }
    }

    /** T062: 암호화 영속 백업(identity/fabric/endpoint registry). 호출 진입점(API/CLI)은 호출자가 연결한다. */
    async createPersistentBackup(passphrase: string): Promise<void> {
        await this.runtime.createPersistentBackup(passphrase);
    }

    /** Matter fabric은 stage되어 다음 시작 시 적용되고, Zigbee 파일은 수동 적용용으로 풀어 둔다. 적용에는 재시작이 필요하다. */
    async restorePersistentBackup(passphrase: string): Promise<void> {
        await this.runtime.restorePersistentBackup(passphrase);
    }

    /** z2m-fork: T026 코디네이터 교체 검증 실패 시 Matter 노출만 차단한다(start() 이전에 호출). Zigbee는 계속 동작. */
    public blockMatter(reason: string): void {
        this.matterBlocked ??= reason;
    }

    private degrade(name: "matter" | "api" | "registry", error: unknown, message: string): void {
        this.degraded.set(name, errorMessage(error));
        logger.error(`${message} (${errorChain(error)})`);
    }

    /** T019: live extended PAN ID와 저장된 값을 비교한다. 불일치면 키 재사용을 막기 위해 Matter를 차단한다. */
    private async verifyNetworkBinding(): Promise<void> {
        try {
            const params = await this.zigbee.getNetworkParameters();
            const live = formatExtendedPanId(params.extendedPanID);
            if (live === undefined) return;

            if (!bindingMatches(this.networkIdentity, live)) {
                this.matterBlocked = "network binding mismatch";
                logger.error(
                    `Zigbee extended PAN ID (${live}) differs from the recorded network identity (${this.networkIdentity.extendedPanId}). ` +
                        "Matter is disabled to avoid reusing endpoint keys on a different network.",
                );
            } else if (this.networkIdentity.extendedPanId === undefined) {
                this.networkIdentityStore.recordExtendedPanId(this.networkIdentity, live);
                logger.info("Recorded extended PAN ID for the network identity");
            }
        } catch (error) {
            logger.warning(`Network identity binding check failed (${errorMessage(error)})`);
        }
    }

    private async startMatter(): Promise<void> {
        const matterSettings = settings.get().matter;
        const requestedNetwork = matterSettings.network ?? {};
        // Matter.js requires IPv6 by default; MatterNetworkConfig only exposes IPv4 as an optional toggle.
        const network = selectMatterMdnsInterface({...requestedNetwork, ipv4: true});
        if (!requestedNetwork.mdnsInterface && network.mdnsInterface) {
            logger.info(`Matter mDNS automatically selected network interface: ${network.mdnsInterface}`);
        }
        const networkDiagnostics = diagnoseMatterNetwork(network);
        for (const diagnostic of networkDiagnostics) {
            const message = `Matter network [${diagnostic.code}]: ${diagnostic.message}`;
            if (diagnostic.level === "error") logger.error(message);
            else if (diagnostic.level === "warn") logger.warning(message);
            else logger.info(message);
        }
        const networkError = networkDiagnostics.find((diagnostic) => diagnostic.level === "error");
        if (networkError) throw new Error(`Matter network preflight failed: ${networkError.message}`);

        const attestation = resolveAttestation(matterSettings.attestation, data.joinPath("matter"));
        this.matterVendorId = attestation.vendorId;
        for (const warning of attestation.warnings) logger.warning(warning);

        if (await this.fileFabricStore?.applyPendingRestore()) {
            logger.info("Applied pending Matter fabric restore (previous storage kept as matter/storage.bak)");
        }
        await this.runtime.startMatter({
            id: this.bridgeIdentity,
            attestation,
            vendorId: attestation.vendorId,
            productId: attestation.productId,
            ...(Object.keys(network).length > 0 ? {network} : {}),
            ...(matterSettings.passcode !== undefined ? {passcode: matterSettings.passcode} : {}),
            ...(matterSettings.discriminator !== undefined ? {discriminator: matterSettings.discriminator} : {}),
        });
        await this.restoreMatterEndpoints();
        this.runtime.commissioning.onFabricsChanged((fabricIndex, action) => {
            const fabrics = this.runtime.commissioning.listFabrics();
            logger.info(`Matter fabric ${action} after commissioning finalization (index=${fabricIndex}, committed=${fabrics.length})`);
            this.runtime.events.publish("transient", "matter/fabrics", {fabricIndex, action, fabrics});
        });
    }

    private async restoreSnapshot(snapshot: {
        identity: unknown;
        fabric: unknown;
        endpointRegistry: unknown;
        zigbee?: unknown;
    }): Promise<{applied: boolean; reason?: string}> {
        const identity = snapshot.identity;
        if (!isRecord(identity) || identity.networkId !== this.networkIdentity.networkId) {
            return {applied: false, reason: "backup network identity does not match this bridge"};
        }
        if (identity.bridgeId !== this.bridgeIdentity) {
            return {applied: false, reason: "backup bridge identity does not match this bridge"};
        }
        const registry = this.runtime.currentEndpointRegistry;
        if (!registry) return {applied: false, reason: "endpoint registry is not open"};
        if (snapshot.zigbee !== undefined && !isFileSet(snapshot.zigbee)) return {applied: false, reason: "backup zigbee data is invalid"};
        const previousFabric = await this.runtime.matter.snapshotFabric();
        const previousRegistry = registry.serialize();
        try {
            await registry.restore(snapshot.endpointRegistry as EndpointRegistryDocument);
            await this.runtime.matter.restoreFabric(snapshot.fabric);
            if (snapshot.zigbee !== undefined) {
                validateFileSet(snapshot.zigbee);
                const target = data.joinPath("backups/restore-zigbee");
                await rm(target, {recursive: true, force: true});
                await writeFileSet(target, snapshot.zigbee);
                logger.warning(
                    "Zigbee files from the backup were extracted to backups/restore-zigbee; copy them into the data directory while stopped",
                );
            }
        } catch (error) {
            try {
                await registry.restore(previousRegistry);
                await this.runtime.matter.restoreFabric(previousFabric);
            } catch (rollbackError) {
                logger.error(`Persistent backup rollback failed (${errorMessage(rollbackError)})`);
            }
            throw error;
        }

        return {applied: true};
    }

    // ---- 상태 / T020 / T011 ----

    private onStateChange(change: eventdata.StateChange): void {
        if (!this.identityReady) return;
        // last_seen 갱신은 상태 보고가 아니다.
        if (change.reason === "lastSeenChanged") return;

        const {state: stateOnly} = splitActions(change.to);
        const {state: updateOnly, actions} = splitActions(change.update);

        if (change.reason === "commandOptimistic" || change.reason === "groupOptimistic") {
            // 낙관값은 의도(desired)일 뿐 confirmed 관측이 아니다.
            for (const target of this.stateSnapshotsForEntity(change.entity, updateOnly)) {
                this.runtime.stateSnapshots.desire(target.key, target.value);
            }
        } else if (change.reason === "publishCached") {
            for (const target of this.stateSnapshotsForEntity(change.entity, stateOnly)) {
                this.runtime.stateSnapshots.estimate(target.key, target.value);
            }
        } else {
            // 실제 기기 보고(reason 없음/debounce/throttle)만 confirmed 관측이다.
            for (const target of this.stateSnapshotsForEntity(change.entity, stateOnly)) {
                this.runtime.stateSnapshots.observe(target.key, target.value);
            }
        }

        // 버튼 action은 상태 병합 없이 1회만 Matter로 전달한다.
        const optimistic = change.reason === "commandOptimistic" || change.reason === "groupOptimistic" || change.reason === "publishCached";
        if (change.entity.isDevice() && Object.keys(actions).length > 0 && !optimistic) {
            void this.deliverAction(change.entity, actions);
        }
    }

    /** identity 확정 전에 놓친 이벤트를 보완하기 위해 현재 캐시 상태/가용성으로 snapshot을 재구성한다(추정값). */
    private seedSnapshots(): void {
        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) {
            const current = this.state.get(device);
            const {state: stateOnly} = splitActions(current);
            for (const target of this.stateSnapshotsForEntity(device, stateOnly)) {
                this.runtime.stateSnapshots.estimate(target.key, target.value);
                if (current.available === true) this.runtime.stateSnapshots.markAvailable(target.key);
                else if (current.available === false) this.runtime.stateSnapshots.markUnavailable(target.key);
            }
        }
    }

    private async deliverAction(device: Device, actions: Record<string, unknown>): Promise<void> {
        for (const endpoint of device.zh.endpoints) {
            const route = this.matterRoute(device, endpoint.ID);
            if (!route) continue;
            try {
                await this.updateMatter(route.key, actions);
            } catch (error) {
                logger.warning(`Matter action delivery failed for ${device.name}: ${errorMessage(error)}`);
            }
        }
    }

    private onAvailabilityPublished(published: eventdata.BridgeBusMessagePublished): void {
        if (!this.identityReady) return;
        const prefix = `${BASE_TOPIC}/`;
        if (!published.topic.startsWith(prefix) || !published.topic.endsWith("/availability")) return;

        const name = published.topic.substring(prefix.length, published.topic.length - "/availability".length);
        const entity = this.zigbee.resolveEntity(name);
        if (!entity) return;

        let payload: unknown;
        try {
            payload = JSON.parse(published.payload);
        } catch {
            return;
        }

        if (!isRecord(payload) || (payload.state !== "online" && payload.state !== "offline")) return;
        for (const state of this.stateSnapshotsForEntity(entity)) {
            if (payload.state === "online") this.runtime.stateSnapshots.markAvailable(state.key);
            else this.runtime.stateSnapshots.markUnavailable(state.key);
        }
    }

    private stateSnapshotsForEntity(
        entity: Device | Group,
        state: Record<string, unknown> = {},
    ): readonly {key: string; value: Record<string, unknown>}[] {
        if (entity.isDevice()) {
            return entity.zh.endpoints.flatMap((endpoint) => {
                const key = deviceKeyOf(this.networkIdentity.networkId, entity.zh, endpoint, "state");

                if (key === undefined) return [];

                return [{key: formatDeviceKey(key), value: stateForEndpoint(state, entity.endpointName(endpoint), String(endpoint.ID))}];
            });
        }

        const key = groupKeyOf(this.networkIdentity.networkId, entity.zh, "state");

        return key === undefined ? [] : [{key: formatGroupKey(key), value: state}];
    }

    // ---- fanout 소비자 (T016/T017) ----

    /** Never awaits SDK writes: the fanout pumps one event at a time, so awaiting here would serialize every device behind the slowest one. */
    private onMatterEvent(event: BridgeEvent): void {
        if (event.type === "snapshot") {
            this.resyncMatter();

            return;
        }
        if (event.type !== "delta" && event.type !== "availability") return;

        this.applyRecordToMatter(event.key, event.type, event.payload);
    }

    private applyRecordToMatter(eventKey: string, type: "delta" | "availability", payload: unknown): void {
        const key = parseEntityKey(eventKey);
        if (key?.kind !== "device" || !isRecord(payload) || payload.removed === true) return;

        let value: Record<string, unknown> | undefined;
        if (type === "availability") {
            if (typeof payload.availability === "boolean") value = {available: payload.availability};
        } else if (isRecord(payload.observedValue)) {
            value = {
                ...payload.observedValue,
                ...(isRecord(payload.desiredValue) ? payload.desiredValue : {}),
            };
        }
        if (value === undefined) return;

        const device = this.zigbee.resolveEntity(toHerdsmanIeee(key.ieee));
        const route = device?.isDevice() ? this.matterRoute(device, key.endpoint) : undefined;
        const ownKey = makeDeviceKey(key.networkId, key.ieee, key.endpoint, "matter");
        const matterKey = route?.key ?? ownKey;
        if (!ownKey || !matterKey) return;
        // Slot per Zigbee endpoint so independent gangs keep writing concurrently.
        void this.pushToMatter(formatDeviceKey(ownKey), matterKey, value, eventKey);
    }

    /** Zigbee endpoint IDs exposed as independent Matter light devices (ascending). */
    private independentLightEndpoints(device: Device): number[] {
        if (device.zh.endpoints.length < 2) return [];
        const minId = Math.min(...device.zh.endpoints.map((item) => item.ID));
        const gangs = device.zh.endpoints
            .filter((endpoint) => {
                const plan = planEndpointMapping(this.endpointExposes(device, endpoint), {isPrimaryEndpoint: endpoint.ID === minId});

                return plan.capabilities.light !== undefined || plan.capabilities.switch !== undefined;
            })
            .map((endpoint) => endpoint.ID)
            .sort((a, b) => a - b);

        return gangs.length >= 2 ? gangs : [];
    }

    private matterRoute(device: Device, endpointId: number): {key: NonNullable<ReturnType<typeof makeDeviceKey>>} | undefined {
        const key = makeDeviceKey(this.networkIdentity.networkId, device.ieeeAddr, endpointId, "matter");

        return key === undefined ? undefined : {key};
    }

    private matterDeviceName(device: Device, endpointId: number, baseName = device.name): string {
        const index = this.independentLightEndpoints(device).indexOf(endpointId);

        return index < 0 ? baseName : `${baseName} ${index + 1}`;
    }

    private async updateMatter(key: NonNullable<ReturnType<typeof makeDeviceKey>>, state: Record<string, unknown>, part?: string): Promise<void> {
        if (part === undefined) {
            await this.runtime.updateMatterEndpoint(key, state);

            return;
        }
        const entry = this.runtime.currentEndpointRegistry?.get(key);
        if (entry) await this.endpointFactory.updateState?.(entry, state, part);
    }

    /**
     * Per-endpoint last-write-wins: endpoints write concurrently; a burst for one endpoint collapses into at most one extra write.
     * Fabric fan-out (subscription reports to every controller) is done by matter.js, not here.
     */
    private async pushToMatter(
        slotId: string,
        matterKey: NonNullable<ReturnType<typeof makeDeviceKey>>,
        value: Record<string, unknown>,
        eventKey: string,
        part?: string,
    ): Promise<void> {
        const running = this.matterWrites.get(slotId);
        if (running) {
            running.pending = {...running.pending, ...value};

            return;
        }

        const slot: {pending?: Record<string, unknown>} = {};
        this.matterWrites.set(slotId, slot);
        try {
            let next: Record<string, unknown> | undefined = value;
            while (next !== undefined) {
                slot.pending = undefined;
                try {
                    await this.updateMatter(matterKey, next, part);
                    if (typeof next.humidity === "number") {
                        logger.info(`Matter humidity update applied for ${eventKey}: ${next.humidity}%`);
                    }
                } catch (error) {
                    logger.warning(`Matter state update failed for ${eventKey} (fields=${Object.keys(next).join(",")}): ${errorMessage(error)}`);
                }
                next = slot.pending;
            }
        } finally {
            this.matterWrites.delete(slotId);
        }
    }

    /** 이벤트 드롭 후 소비자 상태를 현재 snapshot으로 다시 맞춘다. */
    private resyncMatter(): void {
        for (const record of this.runtime.stateSnapshots.peek().records) {
            this.applyRecordToMatter(record.key, "delta", record);
            this.applyRecordToMatter(record.key, "availability", record);
        }
    }

    private onHaEvent(event: BridgeEvent): void {
        if (event.type === "snapshot") {
            for (const record of this.runtime.stateSnapshots.peek().records) this.publishHaState(record.key, record);

            return;
        }
        if (event.type !== "delta" && event.type !== "availability") return;

        this.publishHaState(event.key, event.payload);
    }

    private publishHaState(eventKey: string, payload: unknown): void {
        if (isRecord(payload) && payload.removed !== true) this.haBridge.applyState({...payload, key: eventKey});
        const key = parseEntityKey(eventKey);
        if (!key || !this.ha.entities().some((entity) => entity.key === eventKey)) return;
        this.ha.publishState("matter", key, payload, Date.now());
    }

    // ---- HA 매핑 ----

    private syncHaDevice(device: Device): void {
        if (device.zh.interviewState !== InterviewState.Successful || !device.isSupported) return;
        try {
            const registry = this.runtime.currentEndpointRegistry;
            this.haBridge.syncDevice(
                device.ID,
                mapDeviceExposes(device.exposes(), {
                    networkId: this.networkIdentity.networkId,
                    ieee: device.ieeeAddr,
                    endpointId: (label) => device.endpoint(label)?.ID,
                    matterCovered: (definition) => {
                        const key = this.matterRoute(device, definition.endpointId)?.key;

                        return key !== undefined && registry?.get(key) !== undefined;
                    },
                }),
            );
        } catch (error) {
            logger.warning(`HA entity mapping failed for ${device.name}: ${errorMessage(error)}`);
        }
    }

    // ---- Matter endpoint ----

    private enqueueDeviceOp(device: Device, op: () => Promise<void>): Promise<void> {
        const next = (this.deviceOps.get(device.ieeeAddr) ?? Promise.resolve()).then(op).catch(() => {});
        this.deviceOps.set(device.ieeeAddr, next);
        void next.then(() => {
            if (this.deviceOps.get(device.ieeeAddr) === next) this.deviceOps.delete(device.ieeeAddr);
        });

        return next;
    }

    private syncMatterEndpoints(device: Device, create: boolean): Promise<void> {
        return this.enqueueDeviceOp(device, async () => {
            const runtime = this.runtime.currentDynamicEndpointRuntime;
            if (!runtime) return;

            for (const endpoint of device.zh.endpoints) {
                const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "matter");
                if (!key) continue;
                try {
                    if (this.isMatterEndpointExcluded(key)) {
                        if (this.runtime.currentEndpointRegistry?.get(key)) await this.removeWithRetry(runtime, key);
                        continue;
                    }
                    if (create) await runtime.create(key, true);
                    else await this.removeWithRetry(runtime, key);
                } catch (error) {
                    if (isUnmappable(error)) continue; // 대표가 아닌 endpoint 등 매핑할 capability가 없는 정상 상황
                    logger.warning(`Matter endpoint ${create ? "create" : "remove"} failed for ${device.name}: ${errorMessage(error)}`);
                }
            }
        });
    }

    private shouldExposeMatterDevice(device: Device): boolean {
        return settings.get().matter.expose_devices_after_name_change !== true || device.name !== device.ieeeAddr;
    }

    private isMatterEndpointExcluded(key: RegistryKey): boolean {
        const canonical = typeof key === "string" ? key : "groupId" in key ? formatGroupKey(key) : formatDeviceKey(key);

        return settings.get().matter.excluded_endpoints.includes(canonical);
    }

    /** Bounded retry; the registry tombstone is written only after the SDK delete succeeds, and startup sweeps any leftover active entry. */
    private async removeWithRetry(runtime: DynamicEndpointRuntime, key: RegistryKey): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await runtime.remove(key);

                return;
            } catch (error) {
                const delay = REMOVE_RETRY_DELAYS_MS[attempt];
                if (delay === undefined) throw error;
                logger.warning(`Matter endpoint remove failed (${errorMessage(error)}); retrying in ${delay}ms`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    /** Exposes changed: rebuild only when the derived Matter device type/clusters differ, to avoid churn on controllers. */
    private rebuildMatterEndpoints(device: Device): Promise<void> {
        return this.enqueueDeviceOp(device, async () => {
            const runtime = this.runtime.currentDynamicEndpointRuntime;
            const registry = this.runtime.currentEndpointRegistry;
            if (!runtime || !registry || device.zh.interviewState !== InterviewState.Successful) return;

            for (const endpoint of device.zh.endpoints) {
                const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "matter");
                if (!key) continue;
                try {
                    if (this.isMatterEndpointExcluded(key)) {
                        if (registry.get(key)) await this.removeWithRetry(runtime, key);
                        continue;
                    }
                    const entry = registry.get(key);
                    if (entry === undefined) await runtime.create(key, true);
                    else if (await this.endpointFactory.hasPlanChanged?.(entry)) {
                        await runtime.rebuild(key);
                        logger.info(`Matter endpoint rebuilt for ${device.name} after exposes changed`);
                    }
                } catch (error) {
                    if (isUnmappable(error)) continue;
                    logger.warning(`Matter endpoint rebuild failed for ${device.name}: ${errorMessage(error)}`);
                }
            }
        });
    }

    /** Rename: update the live bridged label. Nothing name-related is persisted, so restarts rebuild from the current friendly name. */
    private relabelMatterEndpoints(device: Device, name: string): Promise<void> {
        return this.enqueueDeviceOp(device, async () => {
            const registry = this.runtime.currentEndpointRegistry;
            if (!registry) return;

            for (const endpoint of device.zh.endpoints) {
                const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "matter");
                const entry = key ? registry.get(key) : undefined;
                if (!entry) continue;
                try {
                    await this.endpointFactory.updateLabel?.(entry, this.matterDeviceName(device, endpoint.ID, name));
                } catch (error) {
                    logger.warning(`Matter label update failed for ${name}: ${errorMessage(error)}`);
                }
            }
        });
    }

    private async restoreMatterEndpoints(): Promise<void> {
        const runtime = this.runtime.currentDynamicEndpointRuntime;
        if (!runtime) return;

        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) {
            if (device.zh.interviewState !== InterviewState.Successful) continue;

            for (const endpoint of device.zh.endpoints) {
                const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "matter");
                if (!key) continue;
                try {
                    if (this.isMatterEndpointExcluded(key)) {
                        if (this.runtime.currentEndpointRegistry?.get(key)) await this.removeWithRetry(runtime, key);
                        continue;
                    }
                    // The factory resolves the source lazily, so labels always come from the current friendly name.
                    const restored = await runtime.restore(key);
                    if (restored === undefined) {
                        if (this.shouldExposeMatterDevice(device)) await runtime.create(key, true);
                    } else if (await this.endpointFactory.hasPlanChanged?.(restored.entry)) {
                        await runtime.rebuild(key);
                    }
                } catch (error) {
                    if (isUnmappable(error)) continue;
                    logger.warning(`Matter endpoint restore failed for ${device.name}: ${errorMessage(error)}`);
                }
            }
        }

        await this.sweepOrphanEndpoints(runtime);
    }

    /** Tombstones active registry entries whose Zigbee device/endpoint no longer exists (e.g. a remove that failed before shutdown). */
    private async sweepOrphanEndpoints(runtime: DynamicEndpointRuntime): Promise<void> {
        // Safety: with no Zigbee device loaded at all (empty/reset database) every entry would look orphaned; never tombstone then.
        const devices = new Map<string, Device>();
        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) devices.set(device.ieeeAddr.toLowerCase(), device);
        if (devices.size === 0) return;

        for (const entry of this.runtime.currentEndpointRegistry?.list() ?? []) {
            if (entry.state !== "active") continue;
            const parsed = parseEntityKey(entry.key);
            if (parsed?.kind !== "device" || parsed.networkId !== this.networkIdentity.networkId) continue;
            const device = devices.get(toHerdsmanIeee(parsed.ieee));
            if (device?.zh.getEndpoint(parsed.endpoint)) continue;

            const key = makeDeviceKey(parsed.networkId, parsed.ieee, parsed.endpoint, "matter");
            if (!key) continue;
            try {
                await runtime.remove(key);
                logger.info(`Removed orphaned Matter endpoint ${entry.endpointId}`);
            } catch (error) {
                logger.warning(`Orphaned Matter endpoint cleanup failed for ${entry.endpointId}: ${errorMessage(error)}`);
            }
        }
    }

    /** Exposes that belong to one Zigbee endpoint (labelled for it, or unlabelled shared ones). */
    private endpointExposes(device: Device, endpoint: Device["zh"]["endpoints"][number]): MappingExpose[] {
        const endpointName = device.endpointName(endpoint);

        return device
            .exposes()
            .filter(
                (expose) => expose.endpoint === undefined || expose.endpoint === endpointName || expose.endpoint === String(endpoint.ID),
            ) as MappingExpose[];
    }

    private resolveMatterEndpointSource(entry: EndpointRegistryEntry) {
        const key = parseEntityKey(entry.key);
        if (key?.kind !== "device" || key.networkId !== this.networkIdentity.networkId) return undefined;

        const device = this.zigbee.resolveEntity(toHerdsmanIeee(key.ieee));
        if (!device?.isDevice()) return undefined;
        const endpoint = device.zh.getEndpoint(key.endpoint);
        if (!endpoint) return undefined;

        const source = this.matterSourceFor(device, endpoint, entry);
        const mapping = planEndpointMapping(source.exposes, {isPrimaryEndpoint: source.isPrimaryEndpoint});
        if (mapping.capabilities.temperature && mapping.capabilities.humidity) {
            const sensorPart = (id: "temperature" | "humidity", label: string) => ({
                id,
                label,
                stateFields: [id],
                source: {...source, exposes: source.exposes.filter((expose) => expose.type === "numeric" && expose.name === id)},
            });
            return {...source, composed: [sensorPart("temperature", "Temperature"), sensorPart("humidity", "Humidity")]};
        }

        return source;
    }

    private matterSourceFor(device: Device, endpoint: Device["zh"]["endpoints"][number], entry: EndpointRegistryEntry) {
        const mapping = planEndpointMapping(this.endpointExposes(device, endpoint), {
            isPrimaryEndpoint: endpoint.ID === Math.min(...device.zh.endpoints.map((item) => item.ID)),
        });
        const switchDeviceType: "OnOffLight" | "OnOffPlugInUnit" = mapping.capabilities.light !== undefined ? "OnOffLight" : "OnOffPlugInUnit";

        return {
            name: this.matterDeviceName(device, endpoint.ID),
            available: this.state.get(device).available !== false,
            vendorId: this.matterVendorId,
            exposes: this.endpointExposes(device, endpoint),
            isPrimaryEndpoint: endpoint.ID === Math.min(...device.zh.endpoints.map((item) => item.ID)),
            switchDeviceType,
            invertCover: (device.options as KeyValue).invert_cover === true,
            lockCommandsAllowed: true,
            // Matter 명령도 공통 CommandRouter 경로(권한/검증/큐/중복/결과 이벤트)를 거친다(T012).
            send: async (payload: Record<string, unknown>): Promise<void> => {
                logger.info(`Matter command requested: device=${device.name} endpoint=${endpoint.ID} payload=${JSON.stringify(payload)}`);
                const result = await this.submit({
                    requestId: randomUUID(),
                    correlationId: randomUUID(),
                    source: "matter",
                    identity: {principal: `matter:${entry.endpointId}`, scope: "control"},
                    deadline: Date.now() + 10_000,
                    operation: "set",
                    target: {key: entry.key},
                    value: payload,
                });
                logger.info(
                    `Matter command result: device=${device.name} endpoint=${endpoint.ID} status=${result.status} dispatched=${result.dispatched}`,
                );
                if (result.status === "failed" || result.status === "timeout") {
                    throw new Error(`${result.errorCode ?? result.status}: ${result.errorMessage ?? "command failed"}`);
                }
            },
        };
    }

    // ---- REST ----

    private listRestDevices(): readonly RestDevice[] {
        return [...this.zigbee.devicesIterator(utils.deviceNotCoordinator)].map((device) => ({
            id: device.ID,
            name: device.name,
            available: this.state.get(device).available !== false,
            vendor: device.definition?.vendor,
            model: device.definition?.model,
            entities: this.haBridge.restEntities(device.ID),
        }));
    }

    private listRestJobs(): readonly unknown[] {
        const extension = this.getExtension("OTAUpdate");

        return extension instanceof ExtensionOTAUpdate ? extension.listJobs() : [];
    }

    private listRestGroups(): readonly RestGroup[] {
        return [...this.zigbee.groupsIterator()].map((group) => ({
            id: group.ID,
            name: group.name,
            available: this.state.get(group).available !== false,
            members: group.zh.members.map((member) => ({ieeeAddress: member.deviceIeeeAddress, endpoint: member.ID})),
        }));
    }

    private listRestBridges(): readonly RestBridge[] {
        return [
            {
                id: this.bridgeIdentity,
                networkId: this.networkIdentity.networkId,
                matterEnabled: settings.get().matter.enabled,
                matterRunning: this.runtime.matter.currentNode !== undefined && !this.degraded.has("matter"),
            },
        ];
    }

    private restSettings(): RestSettingsProvider {
        return {
            read: (kind: SettingsKind, id: string): unknown => {
                if (kind === "devices") return settings.getDevice(id);
                if (kind === "groups") return settings.getGroup(id);
                if (id !== this.bridgeIdentity) return undefined;
                const {passcode: _passcode, attestation: _attestation, ...matter} = settings.get().matter;

                return {matter};
            },
        };
    }

    private restUnsupportedFeatures(): RestUnsupportedFeatureProvider {
        const forEndpoint = (endpointId: string): readonly unknown[] => this.runtime.unsupportedFeatures?.unsupportedFor(endpointId) ?? [];

        return {
            forEndpoint,
            list: () =>
                (this.runtime.currentEndpointRegistry?.list() ?? [])
                    .map((entry) => ({endpointId: entry.endpointId, key: entry.key, features: forEndpoint(entry.endpointId)}))
                    .filter((item) => item.features.length > 0),
        };
    }

    private async runMigration(input: unknown): Promise<unknown> {
        if (!isRecord(input)) throw new ApiError("INVALID_ARGUMENT", "migration input must be an object");
        for (const key of ["preflight", "importData", "cutover", "automation"] as const) {
            if (!isRecord(input[key])) throw new ApiError("INVALID_ARGUMENT", `migration ${key} input is required`);
        }

        return await runMigrationOperations(input as unknown as MigrationOperationsInput);
    }

    private async openCommissioningWindow(input: unknown): Promise<unknown> {
        if (!isRecord(input) || typeof input.administratorId !== "string" || typeof input.durationMs !== "number") {
            throw new ApiError("INVALID_ARGUMENT", "administratorId and durationMs are required");
        }
        // Multi-admin: a window may be opened while fabrics exist (Apple + Google + SmartThings...). An open window is returned as-is.
        const active = this.runtime.commissioning.getActiveWindow();
        if (active) return active;
        const maxFabrics = this.runtime.matter.currentNode?.state?.operationalCredentials?.supportedFabrics ?? DEFAULT_MAX_FABRICS;
        if (this.runtime.commissioning.listFabrics().length >= maxFabrics) {
            throw new ApiError("CONFLICT", `Matter fabric limit reached (${maxFabrics}); remove a fabric before adding another ecosystem`);
        }

        return await this.runtime.commissioning.openWindow(input.administratorId, input.durationMs);
    }

    /**
     * Fabric add/delete/update notifications (SDK `commissioning.fabricsChanged`). Valid after Matter started; returns an unsubscribe.
     * The same changes are also published on the event stream as transient `matter/fabrics` events.
     */
    public onMatterFabricsChanged(listener: (fabricIndex: number, action: FabricChangeAction) => void): () => void {
        return this.runtime.commissioning.onFabricsChanged(listener);
    }

    // ---- 명령 ----

    private resolveCommandTarget(target: {entity?: string; key?: string; endpoint?: string}): ResolvedTarget {
        let entityName = target.entity;
        let endpoint = target.endpoint;
        let endpointFromKey = false;
        if (target.key !== undefined) {
            const key = parseEntityKey(target.key);
            if (key === undefined || key.networkId !== this.networkIdentity.networkId) {
                return {ok: false, errorCode: "NOT_FOUND", message: "target key not found"};
            }
            if (key.kind === "device") {
                const device = this.zigbee.resolveEntity(toHerdsmanIeee(key.ieee));
                if (!device?.isDevice()) return {ok: false, errorCode: "NOT_FOUND", message: "target key not found"};
                entityName = device.name;
                endpoint = String(key.endpoint);
                const resolvedEndpoint = device.endpoint(endpoint);
                const endpointName = resolvedEndpoint ? device.endpointName(resolvedEndpoint) : undefined;
                if (endpointName !== undefined) endpoint = endpointName;
                endpointFromKey = true;
            } else {
                const group = this.zigbee.groupByID(key.groupId);
                if (!group) return {ok: false, errorCode: "NOT_FOUND", message: "target key not found"};
                entityName = group.name;
                endpoint = undefined;
            }
        }
        if (entityName === undefined) return {ok: false, errorCode: "NOT_FOUND", message: "target not found"};
        const entity = this.zigbee.resolveEntity(entityName);
        if (!entity) return {ok: false, errorCode: "NOT_FOUND", message: "target not found"};

        if (entity.isDevice()) {
            const endpointNames = entity.zh.endpoints.map((item) => String(item.ID));
            if (entity.definition?.endpoint) endpointNames.push(...Object.keys(entity.definition.endpoint(entity.zh)));
            if (endpoint !== undefined && !endpointNames.includes(endpoint) && (endpointFromKey || !/^\d+$/.test(endpoint))) {
                return {ok: false, errorCode: "NOT_FOUND", message: "endpoint not found"};
            }

            return {
                ok: true,
                name: entity.name,
                kind: "device",
                supported: entity.isSupported,
                endpointNames: [...new Set(endpointNames)],
                ...(endpoint === undefined ? {} : {endpoint}),
            };
        }

        if (endpoint !== undefined) return {ok: false, errorCode: "INVALID_ARGUMENT", message: "groups have no endpoint"};

        return {ok: true, name: entity.name, kind: "group", supported: true, endpointNames: []};
    }

    private commandQueueKeys(command: Command): readonly string[] {
        if (command.operation === "request") return [`bridge:${command.target.request}`];

        const resolved = this.resolveCommandTarget(command.target);
        if (!resolved.ok) return [command.target.key ?? command.target.entity ?? "unknown"];

        const entity = this.zigbee.resolveEntity(resolved.name);
        if (!entity) return [resolved.name];
        if (entity.isDevice()) {
            const endpoints = resolved.endpoint ? [entity.endpoint(resolved.endpoint)] : entity.zh.endpoints;

            return endpoints
                .filter((endpoint): endpoint is NonNullable<typeof endpoint> => endpoint !== undefined)
                .map((endpoint) => `device/${entity.ieeeAddr}/${endpoint.ID}`);
        }

        return [`group/${entity.ID}`, ...entity.zh.members.map((member) => `device/${member.deviceIeeeAddress}/${member.ID}`)];
    }

    /** 명령 결과마다: 큐/중복 제거/의도 기록/결과 이벤트. 한 소비자의 예외가 다른 소비자를 막지 않는다. */
    private onCommandResult(result: CommandResult): void {
        try {
            this.commandDeduplicator.onResult(result);
        } finally {
            try {
                this.commandQueue.onResult(result);
            } finally {
                try {
                    this.recordIntent(result);
                } finally {
                    this.runtime.events.publish("commandResult", `command/${result.requestId}`, result, {correlationId: result.correlationId});
                }
            }
        }
    }

    /** T020: 수락된 명령은 desired(의도)로만 기록한다. RF가 나갔을 수 있는 실패/타임아웃은 상태를 unknown으로 표시한다. */
    private recordIntent(result: CommandResult): void {
        const intent = this.intents.get(result.requestId.replace(RETRY_SUFFIX, ""));
        if (!intent) return;

        if (result.status === "accepted" || result.status === "executed" || result.status === "confirmed") {
            if (!intent.desired) {
                intent.desired = true;
                for (const target of intent.targets) this.runtime.stateSnapshots.desire(target.key, target.value);
            }
        } else if (
            result.terminal &&
            result.dispatched &&
            (result.status === "failed" || result.status === "timeout" || result.status === "unknown")
        ) {
            for (const target of intent.targets) this.runtime.stateSnapshots.markUnknown(target.key);
        }
    }

    private async submit(command: Command): Promise<CommandResult> {
        try {
            this.runtime.lifecycle.assertCommandsAllowed();
        } catch (error) {
            throw new ApiError("UNAVAILABLE", errorMessage(error));
        }

        if (command.operation === "set") {
            const resolved = this.resolveCommandTarget(command.target);
            const entity = resolved.ok ? this.zigbee.resolveEntity(resolved.name) : undefined;
            if (entity) {
                const targets = this.stateSnapshotsForEntity(entity, splitActions(command.value).state).filter((target) => {
                    if (!resolved.ok || !entity.isDevice() || resolved.endpoint === undefined) return true;
                    const endpoint = entity.endpoint(resolved.endpoint);

                    return endpoint !== undefined && target.key === this.deviceStateKeyOf(entity, endpoint);
                });
                this.intents.set(command.requestId, {desired: false, targets});
            }
        }

        try {
            return await this.commandRouter.submit(command);
        } finally {
            this.intents.delete(command.requestId);
        }
    }

    private deviceStateKeyOf(device: Device, endpoint: zh.Endpoint): string | undefined {
        const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "state");

        return key === undefined ? undefined : formatDeviceKey(key);
    }

    private async executeRestCommand(input: unknown, principal: Principal): Promise<unknown> {
        if (
            !isRecord(input) ||
            typeof input.requestId !== "string" ||
            typeof input.correlationId !== "string" ||
            typeof input.deadline !== "number"
        ) {
            throw new ApiError("INVALID_ARGUMENT", "requestId, correlationId and deadline are required");
        }
        if (input.operation !== "set" && input.operation !== "get" && input.operation !== "request") {
            throw new ApiError("INVALID_ARGUMENT", "invalid command operation");
        }
        if (!isRecord(input.value) || !isRecord(input.target)) throw new ApiError("INVALID_ARGUMENT", "invalid command target or value");

        const command = {
            requestId: input.requestId,
            correlationId: input.correlationId,
            source: "http" as const,
            identity: {principal: principal.tokenId, scope: principal.scope},
            deadline: input.deadline,
            ...(typeof input.idempotencyKey === "string" ? {idempotencyKey: input.idempotencyKey} : {}),
            operation: input.operation,
            target:
                input.operation === "request"
                    ? {request: typeof input.target.request === "string" ? input.target.request : ""}
                    : {
                          ...(typeof input.target.entity === "string" ? {entity: input.target.entity} : {}),
                          ...(typeof input.target.key === "string" ? {key: input.target.key} : {}),
                          ...(typeof input.target.endpoint === "string" ? {endpoint: input.target.endpoint} : {}),
                      },
            value: input.value,
        } as Command;

        return await this.submit(command);
    }

    private async executeHaCommand(command: HaCommand): Promise<void> {
        const target = command.entity.kind === "device" ? {key: formatDeviceKey(command.entity)} : {key: formatGroupKey(command.entity)};
        const operation = command.service === "get" ? "get" : "set";
        const result = await this.submit({
            requestId: randomUUID(),
            correlationId: randomUUID(),
            source: "internal",
            // 최소 권한: 읽기는 read, 쓰기는 control. admin 요청은 HA 경로로 허용하지 않는다.
            identity: {principal: "ha-integration", scope: operation === "get" ? "read" : "control"},
            deadline: Date.now() + 30_000,
            operation,
            target,
            value: command.data ?? {},
        });
        if (result.status === "failed" || result.status === "timeout") {
            throw new Error(`${result.errorCode ?? result.status}: ${result.errorMessage ?? "command failed"}`);
        }
    }
}
