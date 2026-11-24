import {randomUUID} from "node:crypto";
import bind from "bind-decorator";
import {setLogger as zhSetLogger} from "zigbee-herdsman";
import {InterviewState} from "zigbee-herdsman/dist/controller/model/device";
import {setLogger as zhcSetLogger} from "zigbee-herdsman-converters";
import {BASE_TOPIC, type BridgeBus, type BridgeBusPublishOptions, InProcessBridgeBus} from "./bridgeBus"; // z2m-fork: T005/T006 replaces ./mqtt import, T006 BASE_TOPIC
import EventBus from "./eventBus";
// Extensions
import ExtensionAvailability from "./extension/availability";
import ExtensionBind from "./extension/bind";
import ExtensionBridge from "./extension/bridge";
import ExtensionConfigure from "./extension/configure";
import type Extension from "./extension/extension";
import ExtensionExternalConverters from "./extension/externalConverters";
import ExtensionExternalExtensions from "./extension/externalExtensions";
import ExtensionGroups from "./extension/groups";
import ExtensionHealth from "./extension/health";
import ExtensionNetworkMap from "./extension/networkMap";
import ExtensionOnEvent from "./extension/onEvent";
import ExtensionOTAUpdate from "./extension/otaUpdate";
import ExtensionPublish from "./extension/publish";
import ExtensionReceive from "./extension/receive";
import State from "./state";
import {BridgeRuntime} from "./runtime";
import type {EndpointRegistryDocument} from "./matter/endpointRegistry";
import type {MatterEndpointFactory, MatterFabricStore} from "./matter/sdkRuntime";
import {diagnoseMatterNetwork} from "./matter/networkConfig";
import {resolveAttestation} from "./matter/attestation";
import type {RestBridge, RestDevice, RestGroup} from "./api/restRouter";
import {ApiError, assessTransport, type Principal} from "./api/auth";
import {CallbackHaIntegrationAdapter, HaIntegrationRouter, type HaCommand} from "./api/haIntegration";
import {HaHybridPolicy} from "./api/haHybrid";
import {ReportingRegistry} from "./matter/reporting";
import {CommissioningManager} from "./matter/commissioning";
import {FileApiTokenStore} from "./api/tokenStore";
import {runMigrationOperations, type MigrationOperationsInput} from "./migration/operations";
import CommandRouter from "./command/router";
import CommandLoopGuard from "./command/loopGuard";
import CommandDeduplicator from "./command/deduplication";
import DeviceCommandQueue from "./command/queue";
import type {Command, CommandAuthorizer, ResolvedTarget, TargetResolver} from "./command/types";
import {buildEntityTopic} from "./command/mapping";
import type {Zigbee2MQTTAPI} from "./types/api";
import {
    FileBridgeIdentityStore,
    FileNetworkIdentityStore,
    deviceKeyOf,
    formatDeviceKey,
    formatGroupKey,
    groupKeyOf,
    parseEntityKey,
    toHerdsmanIeee,
    type BridgeId,
    type NetworkIdentity,
} from "./identity";
import logger from "./util/logger";
import {initSdNotify} from "./util/sd-notify";
import data from "./util/data";
import * as settings from "./util/settings";
import {stringify} from "./util/stringify";
import utils from "./util/utils";
import Zigbee from "./zigbee";
import {ZigbeeMatterEndpointFactory} from "./matter/zigbeeEndpointFactory";
import type {MappingExpose} from "./matter/mappingRegistry";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ControllerOptions {
    readonly matterEndpointFactory?: MatterEndpointFactory;
    readonly matterFabricStore?: MatterFabricStore;
    readonly commissioning?: CommissioningManager;
}

export class Controller {
    /** Allows canceling in-progress startup sequence if necessary. Signal can be passed to long-running ops as necessary for finer control. */
    #startAbortController: AbortController | undefined;
    public readonly eventBus: EventBus;
    public readonly zigbee: Zigbee;
    public readonly state: State;
    public readonly runtime: BridgeRuntime;
    public readonly ha: HaIntegrationRouter;
    public readonly haHybrid: HaHybridPolicy;
    public readonly reporting: ReportingRegistry;
    public readonly networkIdentity: NetworkIdentity;
    public readonly bridgeIdentity: BridgeId;
    private readonly commandRouter: CommandRouter;
    private readonly commandDeduplicator: CommandDeduplicator;
    private readonly commandQueue: DeviceCommandQueue;
    public readonly bridgeBus: BridgeBus; // z2m-fork: T006 renamed from mqtt
    private restartCallback: () => Promise<void>;
    private exitCallback: (code: number, restart: boolean) => Promise<void>;
    public readonly extensions: Set<Extension>;
    public readonly extensionArgs: ConstructorParameters<typeof Extension>;
    private sdNotify: Awaited<ReturnType<typeof initSdNotify>>;

    constructor(
        restartCallback: () => Promise<void>,
        exitCallback: (code: number, restart: boolean) => Promise<void>,
        options: ControllerOptions = {},
    ) {
        logger.init();
        zhSetLogger(logger);
        zhcSetLogger(logger);
        this.eventBus = new EventBus();
        const apiSettings = settings.get().api;
        if (apiSettings.enabled && !assessTransport(apiSettings).secure) {
            throw new Error("API requires TLS for non-loopback binding");
        }
        const apiTokenStore = new FileApiTokenStore(data.joinPath("api-tokens.json"));
        this.networkIdentity = new FileNetworkIdentityStore().getOrCreate();
        this.bridgeIdentity = new FileBridgeIdentityStore().getOrCreate();
        const matterEndpointFactory =
            options.matterEndpointFactory ??
            new ZigbeeMatterEndpointFactory({
                loadSdk: () => this.runtime.matter.load(),
                resolve: (entry) => this.resolveMatterEndpointSource(entry),
                onCommandError: (endpointId, error) => {
                    logger.warning(`Matter command delivery failed for ${endpointId}: ${error instanceof Error ? error.message : String(error)}`);
                },
            });
        this.runtime = new BridgeRuntime({
            matterEndpointFactory,
            matterFabricStore: options.matterFabricStore,
            commissioning: options.commissioning,
            backup: {
                snapshotProvider: {
                    identity: () => ({...this.networkIdentity, bridgeId: this.bridgeIdentity}),
                    fabric: () => this.runtime.matter.snapshotFabric(),
                },
                snapshotAdapter: {
                    restore: async (snapshot) => {
                        if (!isRecord(snapshot.identity) || snapshot.identity.networkId !== this.networkIdentity.networkId) {
                            return {applied: false, reason: "backup network identity does not match this bridge"};
                        }
                        if (snapshot.identity.bridgeId !== this.bridgeIdentity) {
                            return {applied: false, reason: "backup bridge identity does not match this bridge"};
                        }
                        const registry = this.runtime.currentEndpointRegistry;
                        if (!registry) return {applied: false, reason: "endpoint registry is not open"};
                        const previousFabric = await this.runtime.matter.snapshotFabric();
                        const previousRegistry = registry.serialize();
                        try {
                            await registry.restore(snapshot.endpointRegistry as EndpointRegistryDocument);
                            await this.runtime.matter.restoreFabric(snapshot.fabric);
                        } catch (error) {
                            try {
                                await registry.restore(previousRegistry);
                                await this.runtime.matter.restoreFabric(previousFabric);
                            } catch (rollbackError) {
                                logger.error(
                                    `Persistent backup rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
                                );
                            }
                            throw error;
                        }
                        return {applied: true};
                    },
                },
            },
            auth: {
                legacyToken: apiSettings.auth_token,
                onChange: (records) => apiTokenStore.save(records),
            },
            initialTokens: apiTokenStore.load(),
            api: apiSettings.enabled
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
                      executeCommand: (input, principal) => this.executeRestCommand(input, principal),
                      runMigration: (input) => this.runMigration(input),
                      matterManagement: {
                          commissioningWindow: () => this.runtime.commissioning.getActiveWindow(),
                          openCommissioningWindow: (input) => this.openCommissioningWindow(input),
                          closeCommissioningWindow: () => this.runtime.commissioning.closeWindow(),
                          listFabrics: () => this.runtime.commissioning.listFabrics(),
                          listEndpoints: () => this.runtime.currentEndpointRegistry?.list() ?? [],
                      },
                      snapshot: () => {
                          const snapshot = this.runtime.stateSnapshots.snapshot();
                          return {
                              epoch: snapshot.epoch,
                              sequence: snapshot.watermark,
                              payload: {records: snapshot.records, revision: snapshot.revision},
                          };
                      },
                  }
                : undefined,
        });
        this.ha = new HaIntegrationRouter();
        this.haHybrid = new HaHybridPolicy();
        const haCommand = (command: HaCommand): Promise<void> => this.executeHaCommand(command);
        this.ha.add(new CallbackHaIntegrationAdapter("direct", {onCommand: haCommand}));
        this.ha.add(new CallbackHaIntegrationAdapter("matter", {onCommand: haCommand}));
        this.ha.connect("direct", {onCommand: haCommand});
        this.ha.connect("matter", {onCommand: haCommand});
        this.haHybrid.connect({onCommand: (mode, command) => this.ha.send(mode, command)});
        this.reporting = new ReportingRegistry(
            (update) => this.ha.publishReport("matter", update),
            (error) => logger.warning(`Matter report delivery failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        this.runtime.subscribePlatform("ha-matter", "matter", async (event) => {
            if (event.type !== "delta" && event.type !== "availability") return;
            const key = parseEntityKey(event.key);
            if (!key || !this.ha.entities().some((entity) => entity.key === event.key)) return;
            this.ha.publishState("matter", key, event.payload, Date.now());
        });
        this.runtime.attachEventBus(this.eventBus);
        this.zigbee = new Zigbee(this.eventBus);
        this.bridgeBus = new InProcessBridgeBus(this.eventBus, BASE_TOPIC); // z2m-fork: T005/T006 in-process bridgeBus, T006 base topic is an internal constant
        this.state = new State(this.eventBus, this.zigbee);
        this.eventBus.onStateChange(this, (data) => {
            for (const state of this.stateSnapshotsForEntity(data.entity, data.to)) {
                this.runtime.stateSnapshots.observe(state.key, state.value);
            }
            if (data.entity.isDevice()) void this.updateMatterState(data.entity, data.to);
        });
        this.eventBus.onBridgeBusMessagePublished(this, (data) => this.onAvailabilityPublished(data));
        this.eventBus.onDeviceInterview(this, (data) => {
            if (data.status === "successful") void this.syncMatterEndpoints(data.device, true);
        });
        this.eventBus.onEntityRemoved(this, (data) => {
            for (const state of this.stateSnapshotsForEntity(data.entity)) {
                this.runtime.stateSnapshots.remove(state.key);
            }
            if (data.entity.isDevice()) void this.syncMatterEndpoints(data.entity, false);
        });
        const resolver: TargetResolver = {
            resolve: (target) => this.resolveCommandTarget(target),
        };
        const authorizer: CommandAuthorizer = {
            authorize: (command) => this.authorizeCommand(command),
        };
        this.commandDeduplicator = new CommandDeduplicator();
        this.commandQueue = new DeviceCommandQueue({keyResolver: (command) => this.commandQueueKeys(command)});
        const commandLoopGuard = new CommandLoopGuard({
            onRepeat: (diagnosis) => {
                this.runtime.events.publish("transient", "command/loop", diagnosis, {correlationId: diagnosis.correlationId});
            },
        });
        this.commandRouter = new CommandRouter({
            eventBus: this.eventBus,
            bridgeBus: this.bridgeBus,
            resolver,
            authorizer,
            loopGuard: commandLoopGuard,
            hooks: {
                admit: this.commandDeduplicator.admit,
                schedule: this.commandQueue.schedule,
                onResult: (result) => {
                    this.commandDeduplicator.onResult(result);
                    this.commandQueue.onResult(result);
                    this.runtime.events.publish("commandResult", `command/${result.requestId}`, result, {correlationId: result.correlationId});
                },
            },
        });
        this.restartCallback = restartCallback;
        this.exitCallback = exitCallback;
        // Initialize extensions.
        this.extensionArgs = [
            this.zigbee,
            this.bridgeBus,
            this.state,
            this.publishEntityState,
            this.eventBus,
            this.enableDisableExtension,
            this.restartCallback,
            this.addExtension,
        ];
        this.extensions = new Set();

        if (settings.get().advanced.enable_external_js) {
            this.extensions.add(new ExtensionExternalConverters(...this.extensionArgs));
        } else {
            logger.info("External JS (converters/extensions) is disabled");
        }

        this.extensions.add(new ExtensionOnEvent(...this.extensionArgs));
        this.extensions.add(new ExtensionBridge(...this.extensionArgs));
        this.extensions.add(new ExtensionPublish(...this.extensionArgs));
        this.extensions.add(new ExtensionReceive(...this.extensionArgs));
        this.extensions.add(new ExtensionConfigure(...this.extensionArgs));
        this.extensions.add(new ExtensionNetworkMap(...this.extensionArgs));
        this.extensions.add(new ExtensionGroups(...this.extensionArgs));
        this.extensions.add(new ExtensionBind(...this.extensionArgs));
        this.extensions.add(new ExtensionOTAUpdate(...this.extensionArgs));
        this.extensions.add(new ExtensionAvailability(...this.extensionArgs));
        this.extensions.add(new ExtensionHealth(...this.extensionArgs));

        if (settings.get().advanced.enable_external_js) {
            this.extensions.add(new ExtensionExternalExtensions(...this.extensionArgs));
        }
    }

    private listRestDevices(): readonly RestDevice[] {
        return [...this.zigbee.devicesIterator(utils.deviceNotCoordinator)].map((device) => ({
            id: device.ID,
            name: device.name,
            available: this.state.get(device).available !== false,
        }));
    }

    private async syncMatterEndpoints(device: import("./model/device").default, create: boolean): Promise<void> {
        const runtime = this.runtime.currentDynamicEndpointRuntime;
        if (!runtime) return;

        for (const endpoint of device.zh.endpoints) {
            const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "matter");
            if (!key) continue;
            try {
                if (create) await runtime.create(key, true);
                else await runtime.remove(key);
            } catch (error) {
                logger.warning(`Matter endpoint ${create ? "create" : "remove"} failed for ${device.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async resolveMatterEndpointSource(entry: import("./matter/endpointRegistry").EndpointRegistryEntry) {
        const key = parseEntityKey(entry.key);
        if (!key || key.kind !== "device" || key.networkId !== this.networkIdentity.networkId) return undefined;

        const device = this.zigbee.resolveEntity(toHerdsmanIeee(key.ieee));
        if (!device || !device.isDevice()) return undefined;
        const endpoint = device.zh.getEndpoint(key.endpoint);
        if (!endpoint) return undefined;
        const endpointName = device.endpointName(endpoint);
        const endpointExposes = device.exposes().filter((expose) =>
            expose.endpoint === undefined || expose.endpoint === endpointName || expose.endpoint === String(endpoint.ID),
        ) as MappingExpose[];

        return {
            name: device.name,
            available: this.state.get(device).available !== false,
            exposes: endpointExposes,
            send: async (payload: Record<string, unknown>) => {
                this.bridgeBus.onMessage(buildEntityTopic(device.name, String(endpoint.ID), "set"), JSON.stringify(payload));
            },
        };
    }

    private async updateMatterState(device: import("./model/device").default, state: Record<string, unknown>): Promise<void> {
        for (const endpoint of device.zh.endpoints) {
            const key = deviceKeyOf(this.networkIdentity.networkId, device.zh, endpoint, "matter");
            if (!key) continue;
            const endpointState = stateForEndpoint(state, device.endpointName(endpoint), String(endpoint.ID));
            try {
                await this.runtime.updateMatterEndpoint(key, endpointState);
            } catch (error) {
                logger.warning(`Matter state update failed for ${device.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private onAvailabilityPublished(data: eventdata.BridgeBusMessagePublished): void {
        const prefix = `${BASE_TOPIC}/`;
        if (!data.topic.startsWith(prefix) || !data.topic.endsWith("/availability")) return;

        const name = data.topic.substring(prefix.length, data.topic.length - "/availability".length);
        const entity = this.zigbee.resolveEntity(name);
        if (!entity) return;

        let payload: unknown;
        try {
            payload = JSON.parse(data.payload);
        } catch {
            return;
        }

        if (!isRecord(payload) || (payload.state !== "online" && payload.state !== "offline")) return;
        const available = payload.state === "online";
        for (const state of this.stateSnapshotsForEntity(entity)) {
            if (available) this.runtime.stateSnapshots.markAvailable(state.key);
            else this.runtime.stateSnapshots.markUnavailable(state.key);
        }
        if (entity.isDevice()) void this.updateMatterState(entity, {available});
    }

    private stateSnapshotsForEntity(
        entity: import("./model/device").default | import("./model/group").default,
        state: Record<string, unknown> = {},
    ): readonly {key: string; value: Record<string, unknown>}[] {
        if (entity.isDevice()) {
            return entity.zh.endpoints.flatMap((endpoint) => {
                const key = deviceKeyOf(this.networkIdentity.networkId, entity.zh, endpoint, "state");
                return key === undefined ? [] : [{key: formatDeviceKey(key), value: stateForEndpoint(state, entity.endpointName(endpoint), String(endpoint.ID))}];
            });
        }

        const key = groupKeyOf(this.networkIdentity.networkId, entity.zh, "state");

        return key === undefined ? [] : [{key: formatGroupKey(key), value: state}];
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
                    const restored = await runtime.restore(key);
                    if (restored === undefined) await runtime.create(key, true);
                } catch (error) {
                    logger.warning(`Matter endpoint restore failed for ${device.name}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
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
                matterRunning: this.runtime.matter.currentNode !== undefined,
            },
        ];
    }

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
                if (!device || !device.isDevice()) return {ok: false, errorCode: "NOT_FOUND", message: "target key not found"};
                entityName = device.name;
                endpoint = String(key.endpoint);
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

    private authorizeCommand(command: Command): {ok: true} | {ok: false; errorCode: "UNAUTHORIZED" | "FORBIDDEN"; message: string} {
        const scope = command.identity.scope;
        if (!scope) return {ok: false, errorCode: "UNAUTHORIZED", message: "no command scope"};
        if (scope === "admin" || (scope === "control" && command.operation !== "get") || (scope === "read" && command.operation === "get")) {
            return {ok: true};
        }
        return {ok: false, errorCode: "FORBIDDEN", message: "insufficient command scope"};
    }

    private commandQueueKeys(command: Command): readonly string[] {
        if (command.operation === "request") return [`bridge:${command.target.request}`];

        const resolved = this.resolveCommandTarget(command.target);
        if (!resolved.ok) return [command.target.key ?? command.target.entity ?? "unknown"];

        const entity = this.zigbee.resolveEntity(resolved.name);
        if (!entity) return [resolved.name];
        if (entity.isDevice()) {
            const endpoints = resolved.endpoint
                ? [entity.endpoint(resolved.endpoint)]
                : entity.zh.endpoints;
            return endpoints
                .filter((endpoint): endpoint is NonNullable<typeof endpoint> => endpoint !== undefined)
                .map((endpoint) => `device/${entity.ieeeAddr}/${endpoint.ID}`);
        }

        return [
            `group/${entity.ID}`,
            ...entity.zh.members.map((member) => `device/${member.deviceIeeeAddress}/${member.ID}`),
        ];
    }

    private async executeRestCommand(input: unknown, principal: Principal): Promise<unknown> {
        this.runtime.lifecycle.assertCommandsAllowed();
        if (!isRecord(input) || typeof input.requestId !== "string" || typeof input.correlationId !== "string" || typeof input.deadline !== "number") {
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
            target: input.operation === "request"
                ? {request: typeof input.target.request === "string" ? input.target.request : ""}
                : {
                      ...(typeof input.target.entity === "string" ? {entity: input.target.entity} : {}),
                      ...(typeof input.target.key === "string" ? {key: input.target.key} : {}),
                      ...(typeof input.target.endpoint === "string" ? {endpoint: input.target.endpoint} : {}),
                  },
            value: input.value,
        } as Command;

        return await this.commandRouter.submit(command);
    }

    private async runMigration(input: unknown): Promise<unknown> {
        if (!isRecord(input)) throw new ApiError("INVALID_ARGUMENT", "migration input must be an object");
        for (const key of ["preflight", "importData", "cutover", "automation"] as const) {
            if (!isRecord(input[key])) throw new ApiError("INVALID_ARGUMENT", `migration ${key} input is required`);
        }
        return await runMigrationOperations(input as unknown as MigrationOperationsInput);
    }

    private openCommissioningWindow(input: unknown): unknown {
        if (!isRecord(input) || typeof input.administratorId !== "string" || typeof input.durationMs !== "number") {
            throw new ApiError("INVALID_ARGUMENT", "administratorId and durationMs are required");
        }
        return this.runtime.commissioning.openWindow(input.administratorId, input.durationMs);
    }

    private async executeHaCommand(command: HaCommand): Promise<void> {
        const target = command.entity.kind === "device" ? {key: formatDeviceKey(command.entity)} : {key: formatGroupKey(command.entity)};
        const operation = command.service === "get" ? "get" : "set";
        await this.executeRestCommand(
            {
                requestId: randomUUID(),
                correlationId: randomUUID(),
                deadline: Date.now() + 30_000,
                operation,
                target,
                value: command.data ?? {},
            },
            {tokenId: "ha-integration", scope: "control", source: "anonymous"},
        );
    }

    async start(): Promise<void> {
        this.#startAbortController = new AbortController();
        const abortSignal = this.#startAbortController.signal;

        if (settings.get().frontend.enabled) {
            const {Frontend} = await import("./extension/frontend.js");

            this.extensions.add(new Frontend(...this.extensionArgs));
        }

        // z2m-fork: T006 HomeAssistant extension is not registered (MQTT Discovery removed, T052 re-introduces HA mapping via Matter)
        if (settings.get().homeassistant.enabled) {
            logger.warning("'homeassistant.enabled' is ignored: the Home Assistant MQTT Discovery integration has been removed");
        }

        this.state.start();

        if (abortSignal.aborted) {
            logger.info(`Zigbee2MQTT start aborted, reason=${abortSignal.reason}`);
            return;
        }

        const info = await utils.getZigbee2MQTTVersion();
        logger.info(`Starting Zigbee2MQTT version ${info.version} (commit #${info.commitHash})`);

        // Start zigbee
        try {
            const started = await this.zigbee.start(abortSignal);

            if (started) {
                this.eventBus.onAdapterDisconnected(this, async () => {
                    logger.error("Adapter disconnected, stopping");
                    await this.stop(false, 2);
                });
            }
        } catch (error) {
            // skip if aborted by `stop`
            if (error !== "SIGINT" && error !== "SIGTERM" && error !== "STOPABORT") {
                logger.error("Failed to start zigbee-herdsman");
                logger.error(
                    "Check https://www.zigbee2mqtt.io/guide/installation/20_zigbee2mqtt-fails-to-start_crashes-runtime.html for possible solutions",
                );
                logger.error("Exiting...");
                // biome-ignore lint/style/noNonNullAssertion: always Error
                logger.error((error as Error).stack!);

                /* v8 ignore start */
                if ((error as Error).message.includes("USB adapter discovery error (No valid USB adapter found)")) {
                    logger.error("If this happens after updating to Zigbee2MQTT 2.0.0, see https://github.com/Koenkk/zigbee2mqtt/discussions/24364");
                }
                /* v8 ignore stop */

                return await this.exit(1);
            }
        }

        if (abortSignal.aborted) {
            logger.info(`Zigbee2MQTT start aborted, reason=${abortSignal.reason}`);
            return;
        }

        // Log zigbee clients on startup
        let deviceCount = 0;

        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) {
            // `definition` validated by `isSupported`
            const model = device.isSupported
                ? // biome-ignore lint/style/noNonNullAssertion: valid from `isSupported`
                  `${device.definition!.model} - ${device.definition!.vendor} ${device.definition!.description}`
                : "Not supported";
            logger.info(`${device.name} (${device.ieeeAddr}): ${model} (${device.zh.type})`);

            deviceCount++;
        }

        logger.info(`Currently ${deviceCount} devices are joined.`);

        // BridgeBus // z2m-fork: T006
        try {
            await this.bridgeBus.connect();
            this.commandQueue.start();
            this.commandRouter.start();
        } catch (error) {
            logger.error(`BridgeBus failed to connect, exiting... (${(error as Error).message})`);
            await this.zigbee.stop();
            return await this.exit(1);
        }

        try {
            await this.runtime.openEndpointRegistry(this.bridgeIdentity);
            if (settings.get().matter.enabled) {
                const networkDiagnostics = diagnoseMatterNetwork(settings.get().matter.network ?? {});
                for (const diagnostic of networkDiagnostics) {
                    const message = `Matter network [${diagnostic.code}]: ${diagnostic.message}`;
                    if (diagnostic.level === "error") logger.error(message);
                    else if (diagnostic.level === "warn") logger.warning(message);
                    else logger.info(message);
                }
                const networkError = networkDiagnostics.find((diagnostic) => diagnostic.level === "error");
                if (networkError) throw new Error(`Matter network preflight failed: ${networkError.message}`);

                const attestation = resolveAttestation(settings.get().matter.attestation, data.joinPath("matter"));
                for (const warning of attestation.warnings) logger.warning(warning);

                await this.runtime.startMatter({
                    id: this.bridgeIdentity,
                    attestation,
                    vendorId: attestation.vendorId,
                    productId: attestation.productId,
                    ...(settings.get().matter.network ? {network: settings.get().matter.network} : {}),
                    ...(settings.get().matter.passcode !== undefined ? {passcode: settings.get().matter.passcode} : {}),
                    ...(settings.get().matter.discriminator !== undefined ? {discriminator: settings.get().matter.discriminator} : {}),
                });
                await this.restoreMatterEndpoints();
            }
            await this.runtime.start();
        } catch (error) {
            logger.error(`Bridge runtime failed to start, exiting... (${(error as Error).message})`);
            try {
                await this.runtime.stop();
            } catch (stopError) {
                logger.error(`Failed to clean up bridge runtime startup (${(stopError as Error).message})`);
            }
            this.commandQueue.stop();
            this.commandRouter.stop();
            await this.bridgeBus.disconnect();
            await this.zigbee.stop();
            return await this.exit(1);
        }

        if (abortSignal.aborted) {
            logger.info(`Zigbee2MQTT start aborted, reason=${abortSignal.reason}`);
            return;
        }

        // copy current Set of extensions to ignore possible external extensions added while looping
        for (const extension of new Set(this.extensions)) {
            await this.startExtension(extension);

            if (abortSignal.aborted) {
                logger.info(`Zigbee2MQTT start aborted, reason=${abortSignal.reason}`);
                return;
            }
        }

        // Send all cached states.
        if (settings.get().advanced.cache_state_send_on_startup && settings.get().advanced.cache_state) {
            for (const entity of this.zigbee.devicesAndGroupsIterator()) {
                if (this.state.exists(entity)) {
                    await this.publishEntityState(entity, this.state.get(entity), "publishCached");

                    if (abortSignal.aborted) {
                        logger.info(`Zigbee2MQTT start aborted, reason=${abortSignal.reason}`);
                        return;
                    }
                }
            }
        }

        this.eventBus.onLastSeenChanged(this, (data) => {
            utils.publishLastSeen(data, settings.get(), false, this.publishEntityState).catch(/* v8 ignore next */ () => {});
        });

        logger.info("Zigbee2MQTT started!");

        this.sdNotify = await initSdNotify();

        settings.setOnboarding(false);

        this.#startAbortController = undefined; // gc
    }

    @bind async enableDisableExtension(enable: boolean, name: string): Promise<void> {
        if (enable) {
            let extension: Extension;

            switch (name) {
                case "Frontend": {
                    if (!settings.get().frontend.enabled) {
                        throw new Error("Tried to enable Frontend extension disabled in settings");
                    }

                    // this is not actually used, not tested either
                    /* v8 ignore start */
                    const {Frontend} = await import("./extension/frontend.js");

                    extension = new Frontend(...this.extensionArgs);

                    break;
                    /* v8 ignore stop */
                }
                case "HomeAssistant": {
                    if (!settings.get().homeassistant.enabled) {
                        throw new Error("Tried to enable HomeAssistant extension disabled in settings");
                    }

                    // z2m-fork: T006 not registered, see start()
                    throw new Error("HomeAssistant extension is not available (MQTT Discovery removed)");
                }
                default: {
                    throw new Error(
                        `Extension ${name} does not exist (should be added with 'addExtension') or is built-in that cannot be enabled at runtime`,
                    );
                }
            }

            const existingExtension = this.getExtension(name);

            if (existingExtension) {
                await this.removeExtension(existingExtension);
            }

            this.extensions.add(extension);
        } else {
            switch (name) {
                case "Frontend": {
                    if (settings.get().frontend.enabled) {
                        throw new Error("Tried to disable Frontend extension enabled in settings");
                    }

                    break;
                }
                case "HomeAssistant": {
                    if (settings.get().homeassistant.enabled) {
                        throw new Error("Tried to disable HomeAssistant extension enabled in settings");
                    }

                    break;
                }
                case "Availability":
                case "Bind":
                case "Bridge":
                case "Configure":
                case "ExternalConverters":
                case "ExternalExtensions":
                case "Groups":
                case "NetworkMap":
                case "OnEvent":
                case "OTAUpdate":
                case "Publish":
                case "Receive": {
                    throw new Error(`Built-in extension ${name} cannot be disabled at runtime`);
                }
            }

            const extension = this.getExtension(name);

            if (extension) {
                await this.removeExtension(extension);
            }
        }
    }

    public getExtension(name: string): Extension | undefined {
        for (const extension of this.extensions) {
            if (extension.constructor.name === name) {
                return extension;
            }
        }
    }

    @bind async addExtension(extension: Extension): Promise<void> {
        for (const ext of this.extensions) {
            if (ext.constructor.name === extension.constructor.name) {
                throw new Error(`Extension with name ${ext.constructor.name} already present`);
            }
        }

        this.extensions.add(extension);
        await this.startExtension(extension);
    }

    async removeExtension(extension: Extension): Promise<void> {
        if (this.extensions.delete(extension)) {
            await this.stopExtension(extension);
        }
    }

    private async startExtension(extension: Extension): Promise<void> {
        try {
            await extension.start();
        } catch (error) {
            logger.error(`Failed to start '${extension.constructor.name}' (${(error as Error).stack})`);
        }
    }

    private async stopExtension(extension: Extension): Promise<void> {
        try {
            await extension.stop();
        } catch (error) {
            logger.error(`Failed to stop '${extension.constructor.name}' (${(error as Error).stack})`);
        }
    }

    async stop(restart = false, code = 0, signal: NodeJS.Signals | undefined = undefined): Promise<void> {
        logger.info(`Stopping Zigbee2MQTT (restart=${restart}, code=${code}, signal=${signal})`);

        this.#startAbortController?.abort(signal ?? "STOPABORT");
        this.sdNotify?.notifyStopping();

        let localCode = 0;
        for (const extension of this.extensions) {
            try {
                await extension.stop();
            } catch (error) {
                logger.error(`Failed to stop '${extension.constructor.name}' (${(error as Error).stack})`);
                localCode = 1;
            }
        }

        this.eventBus.removeListeners(this);
        this.commandQueue.stop();
        this.commandRouter.stop();
        try {
            await this.runtime.stop();
        } catch (error) {
            logger.error(`Failed to stop bridge runtime (${(error as Error).stack})`);
            localCode = 1;
        }

        // Wrap-up
        this.state.stop();
        await this.bridgeBus.disconnect();

        try {
            await this.zigbee.stop();
            logger.info("Stopped Zigbee2MQTT");
        } catch (error) {
            logger.error(`Failed to stop Zigbee2MQTT (${(error as Error).stack})`);
            localCode = 1;
        }

        this.sdNotify?.stop();
        return await this.exit(code !== 0 ? code : localCode, restart);
    }

    async exit(code: number, restart = false): Promise<void> {
        await logger.end();
        return await this.exitCallback(code, restart);
    }

    @bind async publishEntityState(entity: Group | Device, payload: KeyValue, stateChangeReason?: StateChangeReason): Promise<void> {
        let message: Zigbee2MQTTAPI["{friendlyName}"] = {...payload};

        // Update state cache with new state.
        const newState = this.state.set(entity, payload, stateChangeReason);

        if (settings.get().advanced.cache_state) {
            // Add cached state to payload
            message = newState;
        }

        const options: MakePartialExcept<BridgeBusPublishOptions, "clientOptions" | "meta"> = {
            clientOptions: {
                retain: utils.getObjectProperty(entity.options, "retain", false),
            },
            meta: {
                isEntityState: true,
            },
        };

        // z2m-fork: T006 qos/retention removed (no broker); include_device_information moved to `advanced`
        if (entity.isDevice() && settings.get().advanced.include_device_information) {
            message.device = {
                friendlyName: entity.name,
                model: entity.definition?.model,
                ieeeAddr: entity.ieeeAddr,
                networkAddress: entity.zh.networkAddress,
                type: entity.zh.type,
                manufacturerID: entity.zh.manufacturerID,
                powerSource: entity.zh.powerSource,
                applicationVersion: entity.zh.applicationVersion,
                stackVersion: entity.zh.stackVersion,
                zclVersion: entity.zh.zclVersion,
                hardwareVersion: entity.zh.hardwareVersion,
                dateCode: entity.zh.dateCode,
                softwareBuildID: entity.zh.softwareBuildID,
                // Manufacturer name can contain \u0000, remove this.
                // https://github.com/home-assistant/core/issues/85691
                /* v8 ignore next */
                manufacturerName: entity.zh.manufacturerName?.split("\u0000")[0],
            };
        }

        // Add lastseen
        const lastSeen = settings.get().advanced.last_seen;
        if (entity.isDevice() && lastSeen !== "disable" && entity.zh.lastSeen) {
            message.last_seen = utils.formatDate(entity.zh.lastSeen, lastSeen);
        }

        // Add device linkquality.
        if (entity.isDevice() && entity.zh.linkquality !== undefined) {
            message.linkquality = entity.zh.linkquality;
        }

        for (const extension of this.extensions) {
            extension.adjustMessageBeforePublish?.(entity, message);
        }

        // Filter message attributes
        utils.filterProperties(entity.options.filtered_attributes, message);

        if (!utils.objectIsEmpty(message)) {
            const output = settings.get().advanced.output;
            if (output === "attribute_and_json" || output === "json") {
                await this.bridgeBus.publish(entity.name, stringify(message), options);
            }

            if (output === "attribute_and_json" || output === "attribute") {
                await this.iteratePayloadAttributeOutput(`${entity.name}/`, message, options);
            }
        }

        this.eventBus.emitPublishEntityState({entity, message, stateChangeReason, payload});
    }

    async iteratePayloadAttributeOutput(topicRoot: string, payload: KeyValue, options: Partial<BridgeBusPublishOptions>): Promise<void> {
        for (const [key, value] of Object.entries(payload)) {
            let subPayload = value;
            let message: string | undefined;

            // Special cases
            // `objectHasProperties` indexes its argument, so it has to be given an object.
            // The null check three lines below is too late: `color` is nullable like any
            // other attribute, and a null one reaches here before that branch runs.
            if (key === "color" && subPayload != null && utils.objectHasProperties(subPayload, ["r", "g", "b"])) {
                subPayload = [subPayload.r, subPayload.g, subPayload.b];
            }

            // Check Array first, since it is also an Object
            if (subPayload === null || subPayload === undefined) {
                message = "";
            } else if (Array.isArray(subPayload)) {
                message = subPayload.map((x) => `${x}`).join(",");
            } else if (typeof subPayload === "object") {
                await this.iteratePayloadAttributeOutput(`${topicRoot}${key}-`, subPayload, options);
            } else {
                message = typeof subPayload === "string" ? subPayload : stringify(subPayload);
            }

            if (message !== undefined) {
                await this.bridgeBus.publish(`${topicRoot}${key}`, message, options);
            }
        }
    }
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
