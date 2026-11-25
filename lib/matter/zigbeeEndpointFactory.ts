/**
 * Zigbee expose를 matter.js bridged endpoint로 조립하는 production 경계.
 *
 * SDK 정의는 동적으로 로드하고, 승인된 조명 매핑만 선택한다. 정의가 없는
 * expose를 임의의 Matter device type으로 바꾸지 않는다.
 */

import {DEFAULT_BUTTON, mapButtonActionSequence, toSwitchEmission} from "./buttonMapping";
import {matterPercent100thsToZigbee, zigbeeToMatterPercent100ths} from "./coverMapping";
import type {EndpointRegistryEntry} from "./endpointRegistry";
import {toMatterElectrical} from "./energyMapping";
import {
    matterColorToZigbee,
    matterColorXyToZigbee,
    matterLevelToZigbee,
    validateColorTemperatureMireds,
    zigbeeBrightnessToMatter,
    zigbeeColorToMatter,
    zigbeeColorXyToMatter,
} from "./lightingMapping";
import {
    authorizeLockCommand,
    celsiusSetpointToMatter,
    type LockOutcome,
    matterSetpointToCelsius,
    matterSystemModeToZigbee,
    resolveLockOutcome,
    validateThermostatMode,
    zigbeeLockStateToMatter,
    zigbeeSystemModeToMatter,
} from "./lockThermostatMapping";
import {type CapabilityId, type MappingExpose, planEndpointMapping} from "./mappingRegistry";
import type {MatterEndpointFactory, MatterMainModule} from "./sdkRuntime";
import {celsiusToMatter, humidityPercentToMatter, occupancyToMatter} from "./sensorMapping";
import type {FeatureDecision} from "./unsupportedFeatures";

interface EndpointDefinition {
    with(...behaviors: unknown[]): unknown;
}

type Listener<T> = {on(listener: (value: T) => void): void};

interface EndpointEvents {
    // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
    onOff?: {onOff$Changed?: Listener<boolean>};
    // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
    levelControl?: {currentLevel$Changed?: Listener<number>};
    colorControl?: {
        // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
        colorTemperatureMireds$Changed?: Listener<number>;
        // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
        currentHue$Changed?: Listener<number>;
        // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
        currentSaturation$Changed?: Listener<number>;
        // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
        currentX$Changed?: Listener<number>;
        // biome-ignore lint/style/useNamingConvention: $Changed suffix is part of the Matter SDK event API
        currentY$Changed?: Listener<number>;
    };
    thermostat?: Record<string, Listener<number> | undefined>;
}

interface EventAgent {
    context: unknown;
    get(type: unknown): {events: Record<string, {emit(payload: unknown, context?: unknown): void} | undefined>};
}

interface MatterEndpointInstance {
    number?: unknown;
    events?: EndpointEvents;
    set(values: Record<string, unknown>): Promise<void>;
    act?<R>(actor: (agent: EventAgent) => R): Promise<R> | R;
    close(): Promise<void>;
    delete?(): Promise<void>;
}

interface MatterEndpointConstructor {
    new (definition: unknown, options?: Record<string, unknown>): MatterEndpointInstance;
}

interface ZigbeeMatterEndpointSource {
    name: string;
    available: boolean;
    exposes: readonly MappingExpose[];
    send: (payload: Record<string, unknown>) => Promise<void>;
    /** z2m invert_cover 옵션이 켜진 장치면 true. 컨트롤러(통합 단계)가 채운다. */
    invertCover?: boolean;
    /** Matter 쪽 lock/unlock 명령 허용 정책. 기본 true(Matter ACL이 이미 인가). */
    lockCommandsAllowed?: boolean;
    /** 기기의 대표(가장 작은 Zigbee endpoint ID) endpoint면 true(기본 true). 컨트롤러가 채운다. */
    isPrimaryEndpoint?: boolean;
    /**
     * 여러 on/off Zigbee endpoint(예: 3구 스위치)를 한 장치로 묶을 때의 gang 목록. 있으면 root는 BridgedNode이고
     * 각 gang이 child part가 된다. 이 source 자체의 exposes/send는 쓰이지 않고 name/available만 root에 쓰인다.
     */
    composed?: readonly ZigbeeMatterPartSource[];
}

interface ZigbeeMatterPartSource {
    /** Zigbee endpoint ID(문자열). part endpoint id(`gang-<id>`)와 상태 라우팅 키로 쓴다. */
    id: string;
    /** 컨트롤러가 gang을 구분하도록 FixedLabel로 노출할 이름(예: left/center/right). */
    label: string;
    source: ZigbeeMatterEndpointSource;
}

type Capabilities = Partial<Record<CapabilityId, MappingExpose>>;
type SendFn = ZigbeeMatterEndpointSource["send"];
type SetpointRange = {min: number; max: number};
type ColorValues = {hue?: number; saturation?: number; x?: number; y?: number};
type CommandBuilder = () => Record<string, unknown> | undefined;

interface EndpointDefinitionPlan {
    definition: EndpointDefinition;
    capabilities: Capabilities;
    unsupported: readonly FeatureDecision[];
    lightKind?: "light" | "colorTemperature" | "color";
    supportsTilt: boolean;
    /** 버튼용 Switch behavior/definition. 버튼은 항상 자체 GenericSwitch endpoint(root 또는 child part)에서만 이벤트를 낸다. */
    switchBehavior?: unknown;
    switchDefinition?: EndpointDefinition;
    /** 버튼 식별자 목록(action enum values에서 도출). */
    buttons: readonly string[];
    /** root endpoint 자체가 Switch인 버튼(버튼 전용 기기의 첫 버튼). 없으면 모든 버튼이 child part. */
    rootButton?: string;
    setpointRanges: Record<string, SetpointRange>;
    supportedModes: readonly string[];
}

type PlanBase = Omit<EndpointDefinitionPlan, "definition">;

interface ButtonRuntime {
    instance: MatterEndpointInstance;
    longActive: boolean;
}

type Guard = (label: string, fn: () => void) => void;

interface EndpointRuntime {
    instance: MatterEndpointInstance;
    /** 버튼 식별자 -> Switch endpoint. 이벤트는 여기서만 발생한다. */
    buttons: Map<string, ButtonRuntime>;
    /** 버튼 이벤트 직렬화 큐(hold/release 인터리빙 방지). */
    buttonQueue: Promise<void>;
    plan: EndpointDefinitionPlan;
    source: ZigbeeMatterEndpointSource;
    coverPositions: {lift?: number; tilt?: number};
    colorValues: ColorValues;
    lockOutcome?: LockOutcome;
    /** Signature of the plan the SDK endpoint was built from; used to detect expose changes that need a rebuild. */
    signature: string;
    /** 합성(composed) root일 때만: Zigbee endpoint ID -> gang runtime. */
    parts?: Map<string, EndpointRuntime>;
}

interface FactoryOptions {
    loadSdk: () => Promise<MatterMainModule>;
    resolve: (entry: EndpointRegistryEntry) => Promise<ZigbeeMatterEndpointSource | undefined>;
    onCommandError?: (endpointId: string, error: unknown) => void;
}

const SETPOINT_FIELDS: Readonly<Record<string, string>> = {
    occupiedHeatingSetpoint: "occupied_heating_setpoint",
    occupiedCoolingSetpoint: "occupied_cooling_setpoint",
    unoccupiedHeatingSetpoint: "unoccupied_heating_setpoint",
    unoccupiedCoolingSetpoint: "unoccupied_cooling_setpoint",
};

const SWITCH_INITIAL_STATE = {numberOfPositions: 2, currentPosition: 0, multiPressMax: 4, longPressDelay: 500, multiPressDelay: 300};

/**
 * 버튼 식별자 -> child endpoint id. id는 같은 owner(기기 root)의 Parts 내에서만 유일하면 되므로 기기 간 충돌은 없다.
 * 이미 [a-z0-9_-]뿐인 이름은 기존 id를 유지하고, 치환(대문자/특수문자)이 일어난 이름만 원본 해시 접미사로 구분한다.
 */
function buttonPartId(button: string): string {
    if (button === DEFAULT_BUTTON) return "button";
    const safe = button.replace(/[^a-z0-9_-]/g, "_");
    if (safe === button) return `button-${safe}`;
    let hash = 0;
    for (const char of button) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
    return `button-${safe}-${hash.toString(36)}`;
}

/** Stable description of the Matter device type/clusters derived from a plan. */
function planSignature(plan: EndpointDefinitionPlan): string {
    return JSON.stringify([
        Object.keys(plan.capabilities).sort(),
        plan.lightKind,
        plan.supportsTilt,
        plan.buttons,
        plan.rootButton,
        plan.supportedModes,
        plan.setpointRanges,
    ]);
}

function unsupportedError(unsupported: readonly FeatureDecision[]): Error {
    const reasons = unsupported.map((item) => `${item.type}:${item.name ?? ""}`).join(", ");

    return new Error(`Matter mapping is unsupported: no approved capability (unsupported: ${reasons})`);
}

const SENSOR_DEVICES = {
    temperature: "temperature-sensor",
    humidity: "humidity-sensor",
    contact: "contact-sensor",
    occupancy: "occupancy-sensor",
    illuminance: "light-sensor",
    waterLeak: "water-leak-detector",
} as const;

const DEVICE_EXPORTS: Readonly<Record<string, string>> = {
    "extended-color-light": "ExtendedColorLightDevice",
    "color-temperature-light": "ColorTemperatureLightDevice",
    "dimmable-light": "DimmableLightDevice",
    "on-off-light": "OnOffLightDevice",
    "on-off-plug-in-unit": "OnOffPlugInUnitDevice",
    "temperature-sensor": "TemperatureSensorDevice",
    "humidity-sensor": "HumiditySensorDevice",
    "contact-sensor": "ContactSensorDevice",
    "occupancy-sensor": "OccupancySensorDevice",
    "light-sensor": "LightSensorDevice",
    "water-leak-detector": "WaterLeakDetectorDevice",
};

/** Matter char strings are limited in UTF-8 bytes (nodeLabel/productName 32, productLabel 64); longer friendly names fail endpoint validation. */
function fitMatterString(value: string, maxBytes: number): string {
    let out = "";
    for (const char of value) {
        if (Buffer.byteLength(out + char) > maxBytes) break;
        out += char;
    }

    return out;
}

function bridgedBasicInformation(source: ZigbeeMatterEndpointSource, serialNumber: string): Record<string, unknown> {
    return {
        nodeLabel: fitMatterString(source.name, 32),
        productName: fitMatterString(source.name, 32),
        productLabel: fitMatterString(source.name, 64),
        serialNumber,
        reachable: source.available,
    };
}

/** Matter "Common Number" semantic tag namespace (tag value = gang position, 1-based). */
const COMMON_NUMBER_NAMESPACE = 7;

/** gang(Zigbee endpoint) -> child endpoint id. 같은 root 아래에서만 유일하면 된다. */
function gangPartId(zigbeeEndpoint: string): string {
    return `gang-${zigbeeEndpoint}`;
}

export class ZigbeeMatterEndpointFactory implements MatterEndpointFactory {
    private readonly runtimes = new Map<string, EndpointRuntime>();
    private readonly stateUpdates = new Set<string>();

    constructor(private readonly options: FactoryOptions) {}

    async create(entry: EndpointRegistryEntry): Promise<{endpoint: unknown; unsupported: readonly FeatureDecision[]}> {
        const source = await this.options.resolve(entry);
        if (source === undefined) throw new Error(`Matter source is unavailable for ${entry.key}`);

        const sdk = await this.options.loadSdk();
        const Endpoint = sdk.Endpoint as MatterEndpointConstructor | undefined;
        if (!Endpoint) throw new Error("Matter SDK does not expose Endpoint");

        const report = (error: unknown): void => this.options.onCommandError?.(entry.endpointId, error);
        if (source.composed !== undefined && source.composed.length > 0) return await this.createComposed(entry, source, Endpoint, report);

        const plan = await this.definitionFor(source, report);
        const {BridgedDeviceBasicInformationServer} = await import("@matter/main/behaviors/bridged-device-basic-information");
        const runtime = this.instantiate(Endpoint, plan, source, {
            id: entry.endpointId,
            definition: plan.definition.with(BridgedDeviceBasicInformationServer),
            options: {bridgedDeviceBasicInformation: bridgedBasicInformation(source, entry.endpointId)},
        });
        this.bindCommands(runtime.instance, entry.endpointId, source.send, runtime);
        this.runtimes.set(entry.endpointId, runtime);

        return {endpoint: runtime.instance, unsupported: plan.unsupported};
    }

    /**
     * 여러 on/off gang -> 하나의 BridgedNode(root, BridgedDeviceBasicInformation) + gang별 child part.
     * root에는 nodeLabel/reachable/serialNumber만 있고, 각 part는 해당 Zigbee endpoint의 OnOff device type(+FixedLabel)이다.
     */
    private async createComposed(
        entry: EndpointRegistryEntry,
        source: ZigbeeMatterEndpointSource,
        Endpoint: MatterEndpointConstructor,
        report: (error: unknown) => void,
    ): Promise<{endpoint: unknown; unsupported: readonly FeatureDecision[]}> {
        const [{BridgedNodeEndpoint}, {FixedLabelServer}, {DescriptorServer}] = await Promise.all([
            import("@matter/main/endpoints/bridged-node"),
            import("@matter/main/behaviors/fixed-label"),
            import("@matter/main/behaviors/descriptor"),
        ]);
        const parts = new Map<string, EndpointRuntime>();
        const unsupported: FeatureDecision[] = [];
        const signatures: string[] = [];
        for (const [index, part] of (source.composed ?? []).entries()) {
            const plan = await this.definitionFor(part.source, report);
            // Sibling parts share a device type, so the spec requires a TagList (Common Number namespace) to tell them apart.
            const gang = this.instantiate(Endpoint, plan, part.source, {
                id: gangPartId(part.id),
                definition: plan.definition.with(FixedLabelServer, DescriptorServer.with("TagList")),
                options: {
                    fixedLabel: {labelList: [{label: "label", value: fitMatterString(part.label, 16)}]},
                    descriptor: {
                        tagList: [{mfgCode: null, namespaceId: COMMON_NUMBER_NAMESPACE, tag: index + 1, label: fitMatterString(part.label, 64)}],
                    },
                },
            });
            this.bindCommands(gang.instance, `${entry.endpointId}/${part.id}`, part.source.send, gang);
            parts.set(part.id, gang);
            unsupported.push(...plan.unsupported);
            signatures.push(`${part.id}:${gang.signature}`);
        }
        const plan: EndpointDefinitionPlan = {
            definition: BridgedNodeEndpoint as unknown as EndpointDefinition,
            capabilities: {},
            unsupported,
            supportsTilt: false,
            buttons: [],
            setpointRanges: {},
            supportedModes: [],
        };
        const endpoint = new Endpoint(BridgedNodeEndpoint, {
            id: entry.endpointId,
            parts: [...parts.values()].map((gang) => gang.instance),
            bridgedDeviceBasicInformation: bridgedBasicInformation(source, entry.endpointId),
        });
        this.runtimes.set(entry.endpointId, {
            instance: endpoint,
            buttons: new Map(),
            buttonQueue: Promise.resolve(),
            plan,
            source,
            coverPositions: {},
            colorValues: {},
            signature: JSON.stringify(signatures),
            parts,
        });

        return {endpoint, unsupported};
    }

    /** plan으로 endpoint(+버튼 part)를 만든다. root/gang 공통. */
    private instantiate(
        Endpoint: MatterEndpointConstructor,
        plan: EndpointDefinitionPlan,
        source: ZigbeeMatterEndpointSource,
        target: {id: string; definition: unknown; options: Record<string, unknown>},
    ): EndpointRuntime {
        const occupancyInit =
            plan.capabilities.occupancy === undefined
                ? {}
                : {occupancySensing: {occupancySensorType: 0, occupancySensorTypeBitmap: {passiveInfrared: true}}};
        const contactInit = plan.capabilities.contact === undefined && plan.capabilities.waterLeak === undefined ? {} : {booleanState: {stateValue: false}};
        const buttons = new Map<string, ButtonRuntime>();
        const parts: MatterEndpointInstance[] = [];
        if (plan.switchDefinition !== undefined) {
            for (const button of plan.buttons) {
                if (button === plan.rootButton) continue;
                const part = new Endpoint(plan.switchDefinition, {id: buttonPartId(button), switch: SWITCH_INITIAL_STATE});
                parts.push(part);
                buttons.set(button, {instance: part, longActive: false});
            }
        }
        const endpoint = new Endpoint(target.definition, {
            id: target.id,
            ...(parts.length > 0 ? {parts} : {}),
            ...occupancyInit,
            ...contactInit,
            ...initialClusterState(plan.capabilities, plan.rootButton !== undefined),
            ...target.options,
        });

        if (plan.rootButton !== undefined) buttons.set(plan.rootButton, {instance: endpoint, longActive: false});

        return {
            instance: endpoint,
            buttons,
            buttonQueue: Promise.resolve(),
            plan,
            source,
            coverPositions: {},
            colorValues: {},
            signature: planSignature(plan),
        };
    }

    /** 생성된 endpoint에서 Matter로 노출하지 못한 expose 목록(2차 통합에서 API/UI에 연결). */
    unsupportedFor(endpointId: string): readonly FeatureDecision[] {
        return this.runtimes.get(endpointId)?.plan.unsupported ?? [];
    }

    /** 마지막 lock 명령 결과. 장치 상태가 관측되기 전에는 unknown이다. */
    lockOutcomeFor(endpointId: string): LockOutcome | undefined {
        return this.runtimes.get(endpointId)?.lockOutcome;
    }

    readAssignedNumber(entry: EndpointRegistryEntry, endpoint: unknown, added: unknown): number {
        const endpointNumber = (endpoint as MatterEndpointInstance).number;
        const addedNumber = (added as {number?: unknown} | undefined)?.number;
        const number = (endpointNumber ?? addedNumber) as number | undefined;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 0xfffe) {
            throw new Error(`Matter endpoint '${entry.endpointId}' did not receive a valid number`);
        }

        return number;
    }

    discard(entry: EndpointRegistryEntry): void {
        const runtime = this.runtimes.get(entry.endpointId);
        this.runtimes.delete(entry.endpointId);
        this.stateUpdates.delete(entry.endpointId);
        for (const id of runtime?.parts?.keys() ?? []) this.stateUpdates.delete(`${entry.endpointId}/${id}`);
    }

    async remove(entry: EndpointRegistryEntry): Promise<{permanent: boolean}> {
        const runtime = this.runtimes.get(entry.endpointId);
        if (runtime === undefined) return {permanent: true};

        // Keep the runtime on failure so a retry performs the real deletion again.
        const permanent = runtime.instance.delete !== undefined;
        if (permanent) await runtime.instance.delete?.();
        else await runtime.instance.close();
        this.runtimes.delete(entry.endpointId);
        this.stateUpdates.delete(entry.endpointId);
        for (const id of runtime.parts?.keys() ?? []) this.stateUpdates.delete(`${entry.endpointId}/${id}`);

        return {permanent};
    }

    /** Pushes a renamed friendly name to every controller/fabric through the bridged basic information cluster. */
    async updateLabel(entry: EndpointRegistryEntry, name: string): Promise<void> {
        const runtime = this.runtimes.get(entry.endpointId);
        if (runtime === undefined) return;

        runtime.source.name = name;
        await runtime.instance.set({bridgedDeviceBasicInformation: {nodeLabel: fitMatterString(name, 32), productLabel: fitMatterString(name, 64)}});
    }

    /** True when the device's current exposes would produce a different Matter device type/clusters than the live endpoint. */
    async hasPlanChanged(entry: EndpointRegistryEntry): Promise<boolean> {
        const runtime = this.runtimes.get(entry.endpointId);
        if (runtime === undefined) return false;

        const source = await this.options.resolve(entry);
        if (source === undefined) return false;
        try {
            if (source.composed !== undefined && source.composed.length > 0) {
                if (runtime.parts === undefined) return true;
                const signatures: string[] = [];
                for (const part of source.composed) signatures.push(`${part.id}:${planSignature(await this.definitionFor(part.source, () => {}))}`);

                return JSON.stringify(signatures) !== runtime.signature;
            }
            if (runtime.parts !== undefined) return true; // composed -> single (gangs went away)
            const plan = await this.definitionFor(source, () => {});

            return planSignature(plan) !== runtime.signature;
        } catch {
            return false; // unmappable now; keep the existing endpoint rather than dropping it from all fabrics
        }
    }

    /** `part`(Zigbee endpoint ID)는 합성 장치에서 상태를 반영할 gang을 고른다. 없으면 첫 gang. */
    async updateState(entry: EndpointRegistryEntry, state: Record<string, unknown>, part?: string): Promise<void> {
        const runtime = this.runtimes.get(entry.endpointId);
        if (runtime === undefined) return;

        const report = (error: unknown): void => this.options.onCommandError?.(entry.endpointId, error);
        if (runtime.parts === undefined) {
            await this.applyState(runtime, entry.endpointId, state, report);

            return;
        }

        // reachable은 root(BridgedNode)에, 나머지 상태는 해당 gang에 반영한다.
        const {available, ...rest} = state;
        if (typeof available === "boolean") {
            try {
                await runtime.instance.set({bridgedDeviceBasicInformation: {reachable: available}});
            } catch (error) {
                report(error);
            }
        }
        const partId = part ?? runtime.parts.keys().next().value;
        const gang = partId === undefined ? undefined : runtime.parts.get(partId);
        if (gang !== undefined) await this.applyState(gang, `${entry.endpointId}/${partId}`, rest, report);
    }

    private async applyState(
        runtime: EndpointRuntime,
        guardKey: string,
        state: Record<string, unknown>,
        report: (error: unknown) => void,
    ): Promise<void> {
        // 버튼 action은 순간 이벤트다. 속성 patch와 병합하지 않고, patch 계산보다 먼저 별도로 발생시킨다.
        if (runtime.buttons.size > 0 && typeof state.action === "string" && state.action !== "") {
            await this.emitButtonEvent(runtime, state, report);
        }
        const patch = this.buildPatch(runtime, state, report);
        if (Object.keys(patch).length === 0) return;

        this.stateUpdates.add(guardKey);
        try {
            try {
                await runtime.instance.set(patch);
            } catch (error) {
                // 한 cluster 값이 거부돼도 나머지는 반영한다.
                report(error);
                for (const [cluster, values] of Object.entries(patch)) {
                    try {
                        await runtime.instance.set({[cluster]: values});
                    } catch (clusterError) {
                        report(
                            new Error(
                                `state update failed for ${cluster}: ` +
                                    `${clusterError instanceof Error ? clusterError.message : String(clusterError)}`,
                            ),
                        );
                    }
                }
            }
        } finally {
            this.stateUpdates.delete(guardKey);
        }
    }

    /** 필드(그룹)별로 격리한다: 하나가 throw 해도 나머지 patch와 버튼 이벤트는 유지된다. */
    private buildPatch(runtime: EndpointRuntime, state: Record<string, unknown>, report: (error: unknown) => void): Record<string, unknown> {
        const {plan} = runtime;
        const caps = plan.capabilities;
        const patch: Record<string, unknown> = {};
        const guard: Guard = (label, fn) => {
            try {
                fn();
            } catch (error) {
                report(new Error(`state field '${label}' skipped: ${error instanceof Error ? error.message : String(error)}`));
            }
        };

        if (typeof state.available === "boolean") patch.bridgedDeviceBasicInformation = {reachable: state.available};
        if ((caps.light !== undefined || caps.switch !== undefined) && (state.state === "ON" || state.state === "OFF")) {
            patch.onOff = {onOff: state.state === "ON"};
        }
        if (caps.light !== undefined) lightPatch(plan, state, patch, guard);
        if (caps.cover !== undefined) coverPatch(runtime, state, patch, guard);
        electricalPatch(caps, state, patch, guard);
        // null 정책: 값을 알 수 없고(null) Matter 속성이 nullable이면 null로 설정, nullable이 아니면 이전 값을 유지한다.
        // nullable: measuredValue(온도/습도), activePower/rmsVoltage/rmsCurrent/cumulativeEnergyImported, localTemperature, 커튼 위치.
        if (caps.temperature !== undefined && (typeof state.temperature === "number" || state.temperature === null)) {
            guard("temperature", () => {
                const value = celsiusToMatter(state.temperature as number | null);
                patch.temperatureMeasurement = {measuredValue: value.known ? value.value : null};
            });
        }
        if (caps.humidity !== undefined && (typeof state.humidity === "number" || state.humidity === null)) {
            guard("humidity", () => {
                const value = humidityPercentToMatter(state.humidity as number | null);
                patch.relativeHumidityMeasurement = {measuredValue: value.known ? value.value : null};
            });
        }
        if (caps.contact !== undefined && typeof state.contact === "boolean") patch.booleanState = {stateValue: state.contact};
        if (caps.waterLeak !== undefined && typeof state.water_leak === "boolean") patch.booleanState = {stateValue: state.water_leak};
        if (caps.illuminance !== undefined && typeof state.illuminance === "number" && Number.isFinite(state.illuminance)) {
            patch.illuminanceMeasurement = {measuredValue: state.illuminance <= 0 ? 0 : Math.max(1, Math.round(10000 * Math.log10(state.illuminance) + 1))};
        }
        // occupancy capability는 `occupancy` 또는 `presence`(mmWave) expose에서 온다.
        const occupied = state[caps.occupancy?.name ?? "occupancy"];
        if (caps.occupancy !== undefined && typeof occupied === "boolean") patch.occupancySensing = {occupancy: occupancyToMatter(occupied)};
        if (caps.lock !== undefined) guard("lock", () => lockPatch(runtime, state, patch));
        if (caps.thermostat !== undefined) thermostatPatch(plan, state, patch, guard);

        return patch;
    }

    private emitButtonEvent(runtime: EndpointRuntime, state: Record<string, unknown>, report: (error: unknown) => void): Promise<void> {
        const run = async (): Promise<void> => {
            const pressCount = typeof state.action_press_count === "number" ? state.action_press_count : undefined;
            const action = String(state.action);
            // longActive는 버튼별 상태이므로 버튼을 먼저 식별한 뒤 해당 버튼의 상태로 다시 해석한다.
            const probe = mapButtonActionSequence(action, false, pressCount);
            if (!probe.supported) {
                report(new Error(probe.reason));
                return;
            }
            const key = probe.button ?? DEFAULT_BUTTON;
            const target = runtime.buttons.get(key);
            const behavior = runtime.plan.switchBehavior;
            if (target === undefined || target.instance.act === undefined || behavior === undefined) {
                report(new Error(`no Matter Switch endpoint for button '${key}' (action '${action}')`));
                return;
            }
            const result = mapButtonActionSequence(action, target.longActive, pressCount);
            if (!result.supported) {
                report(new Error(result.reason));
                return;
            }

            target.longActive = result.longActive;
            try {
                for (const event of result.events) {
                    const {name, payload} = toSwitchEmission(event);
                    await target.instance.act((agent) => {
                        agent.get(behavior).events[name]?.emit(payload, agent.context);
                    });
                }
            } catch (error) {
                report(error);
            }
        };
        const next = runtime.buttonQueue.then(run, run);
        runtime.buttonQueue = next.catch(() => undefined);

        return next;
    }

    private async definitionFor(source: ZigbeeMatterEndpointSource, report: (error: unknown) => void): Promise<EndpointDefinitionPlan> {
        const mapping = planEndpointMapping(source.exposes, {isPrimaryEndpoint: source.isPrimaryEndpoint});
        const caps = mapping.capabilities;
        const base: PlanBase = {
            capabilities: caps,
            unsupported: mapping.unsupported,
            supportsTilt: false,
            setpointRanges: {},
            supportedModes: [],
            buttons: mapping.buttons,
        };
        const primary = await this.primaryDefinition(base, source, report);
        if (caps.button === undefined) {
            if (primary === undefined) throw unsupportedError(mapping.unsupported);
            return primary;
        }

        // 버튼은 항상 자체 GenericSwitch endpoint에서만 이벤트를 낸다. 다른 primary가 있으면 모든 버튼이 child part,
        // 없으면 첫 버튼이 root endpoint, 나머지가 child part다.
        const [{GenericSwitchDevice}, {SwitchServer}] = await Promise.all([
            import("@matter/main/devices/generic-switch"),
            import("@matter/main/behaviors/switch"),
        ]);
        const switchBehavior = SwitchServer.with(
            "MomentarySwitch",
            "MomentarySwitchRelease",
            "MomentarySwitchLongPress",
            "MomentarySwitchMultiPress",
        );
        const switchDefinition = GenericSwitchDevice.with(switchBehavior) as EndpointDefinition;
        if (primary !== undefined) return {...primary, switchBehavior, switchDefinition};

        return {...base, definition: switchDefinition, switchBehavior, switchDefinition, rootButton: base.buttons[0] ?? DEFAULT_BUTTON};
    }

    /** button 이외의 primary device type. 없으면 undefined. */
    private async primaryDefinition(
        base: PlanBase,
        source: ZigbeeMatterEndpointSource,
        report: (error: unknown) => void,
    ): Promise<EndpointDefinitionPlan | undefined> {
        const caps = base.capabilities;

        if (caps.light) return lightDefinition(base, caps.light, await loadExtraBehaviors(caps));
        if (caps.switch) {
            const device = await loadDevice("on-off-plug-in-unit");
            return {...base, definition: device.with(...(await loadExtraBehaviors(caps))) as EndpointDefinition};
        }
        if (caps.cover) return coverDefinition(base, caps.cover, source, await loadExtraBehaviors(caps), report);
        if (caps.lock) return this.lockDefinition(base, source, await loadExtraBehaviors(caps));
        if (caps.thermostat) return thermostatDefinition(base, caps.thermostat, await loadExtraBehaviors(caps));

        const sensor = (["temperature", "humidity", "contact", "occupancy", "illuminance", "waterLeak"] as const).find((id) => caps[id] !== undefined);
        if (sensor !== undefined) {
            const device = await loadDevice(SENSOR_DEVICES[sensor]);
            return {...base, definition: device.with(...(await loadExtraBehaviors(caps, sensor))) as EndpointDefinition};
        }
        if (caps.power || caps.energy || caps.voltage || caps.current) {
            // 근거: @matter/node@0.18.0 devices/index.d.ts에는 electrical-sensor가 없고 electrical-meter만 있다
            // (매핑 규칙 matterDeviceType도 ElectricalMeter로 통일).
            const {ElectricalMeterDevice} = await import("@matter/main/devices/electrical-meter");
            return {...base, definition: ElectricalMeterDevice.with(...(await loadExtraBehaviors(caps))) as EndpointDefinition};
        }

        return undefined;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
    private async lockDefinition(base: PlanBase, source: ZigbeeMatterEndpointSource, extras: readonly any[]): Promise<EndpointDefinitionPlan> {
        const [{DoorLockDevice}, {DoorLockServer}] = await Promise.all([
            import("@matter/main/devices/door-lock"),
            import("@matter/main/behaviors/door-lock"),
        ]);
        const allowed = source.lockCommandsAllowed ?? true;
        const {send} = source;
        const record = (value: LockOutcome): void => {
            for (const runtime of this.runtimes.values()) if (runtime.source === source) runtime.lockOutcome = value;
        };
        class ZigbeeDoorLockServer extends DoorLockServer {
            async handleLockOperation(operation: {actuation: string}): Promise<void> {
                const command = operation.actuation === "lock" ? "lock" : "unlock";
                try {
                    authorizeLockCommand(command, allowed);
                } catch (error) {
                    record(resolveLockOutcome(undefined, true));
                    throw error;
                }
                // 비멱등 명령: 자동 재시도하지 않고, 장치 상태가 관측되기 전에는 결과를 unknown으로 둔다.
                try {
                    await send({state: command === "lock" ? "LOCK" : "UNLOCK"});
                    record(resolveLockOutcome(undefined));
                } catch (error) {
                    record(resolveLockOutcome(undefined, false, true));
                    throw error;
                }
            }
        }

        return {...base, definition: DoorLockDevice.with(ZigbeeDoorLockServer, ...extras) as EndpointDefinition};
    }

    private bindCommands(endpoint: MatterEndpointInstance, endpointId: string, send: SendFn, runtime: EndpointRuntime): void {
        const {plan} = runtime;
        const command = (build: CommandBuilder): void => {
            if (this.stateUpdates.has(endpointId)) return;
            try {
                const payload = build();
                if (payload !== undefined) void send(payload).catch((error) => this.options.onCommandError?.(endpointId, error));
            } catch (error) {
                this.options.onCommandError?.(endpointId, error);
            }
        };
        const color = (patch: ColorValues, build: (colors: ColorValues) => Record<string, unknown> | undefined): void =>
            command(() => build(Object.assign(runtime.colorValues, patch)));
        const events = endpoint.events;

        events?.onOff?.onOff$Changed?.on((value) => command(() => ({state: value ? "ON" : "OFF"})));
        events?.levelControl?.currentLevel$Changed?.on((value) => command(() => ({brightness: matterLevelToZigbee(value)})));
        events?.colorControl?.colorTemperatureMireds$Changed?.on((value) => command(() => ({color_temp: validateColorTemperatureMireds(value)})));
        events?.colorControl?.currentHue$Changed?.on((hue) =>
            color({hue}, (c) => (c.saturation === undefined ? undefined : {color: matterColorToZigbee(hue, c.saturation)})),
        );
        events?.colorControl?.currentSaturation$Changed?.on((saturation) =>
            color({saturation}, (c) => (c.hue === undefined ? undefined : {color: matterColorToZigbee(c.hue, saturation)})),
        );
        events?.colorControl?.currentX$Changed?.on((x) =>
            color({x}, (c) => (c.y === undefined ? undefined : {color: matterColorXyToZigbee(x, c.y)})),
        );
        events?.colorControl?.currentY$Changed?.on((y) =>
            color({y}, (c) => (c.x === undefined ? undefined : {color: matterColorXyToZigbee(c.x, y)})),
        );
        events?.thermostat?.systemMode$Changed?.on((value) =>
            command(() => {
                const mode = matterSystemModeToZigbee(value);

                return mode === undefined ? undefined : {system_mode: validateThermostatMode(mode, plan.supportedModes)};
            }),
        );
        for (const [attribute, field] of Object.entries(SETPOINT_FIELDS)) {
            events?.thermostat?.[`${attribute}$Changed`]?.on((value) =>
                command(() => ({[field]: matterSetpointToCelsius(value, plan.setpointRanges[field])})),
            );
        }
    }
}

async function loadDevice(path: string): Promise<EndpointDefinition> {
    const module = (await import(`@matter/main/devices/${path}`)) as Record<string, unknown>;

    return module[DEVICE_EXPORTS[path] as string] as EndpointDefinition;
}

/** primary device type에 없는 센서/전력 cluster를 같은 endpoint에 추가할 behavior로 로드한다. */
// biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
async function loadExtraBehaviors(caps: Capabilities, primarySensor?: string): Promise<any[]> {
    const behaviors: unknown[] = [];
    if (caps.temperature && primarySensor !== "temperature") {
        behaviors.push((await import("@matter/main/behaviors/temperature-measurement")).TemperatureMeasurementServer);
    }
    if (caps.humidity && primarySensor !== "humidity") {
        behaviors.push((await import("@matter/main/behaviors/relative-humidity-measurement")).RelativeHumidityMeasurementServer);
    }
    if (caps.contact && primarySensor !== "contact") behaviors.push((await import("@matter/main/behaviors/boolean-state")).BooleanStateServer);
    if (caps.waterLeak && primarySensor !== "waterLeak") {
        const {WaterLeakDetectorRequirements} = await import("@matter/main/devices/water-leak-detector");
        behaviors.push(WaterLeakDetectorRequirements.BooleanStateServer);
    }
    if (caps.illuminance && primarySensor !== "illuminance") {
        behaviors.push((await import("@matter/main/behaviors/illuminance-measurement")).IlluminanceMeasurementServer);
    }
    // OccupancySensorDevice는 OccupancySensing을 필수 기능(PIR) 없이 선언하므로 primary여도 항상 PassiveInfrared로 붙인다.
    if (caps.occupancy) {
        behaviors.push((await import("@matter/main/behaviors/occupancy-sensing")).OccupancySensingServer.with("PassiveInfrared"));
    }
    if (caps.power || caps.voltage || caps.current) {
        const {ElectricalPowerMeasurementServer} = await import("@matter/main/behaviors/electrical-power-measurement");
        const ac = caps.voltage || caps.current;
        behaviors.push(ac ? ElectricalPowerMeasurementServer.with("AlternatingCurrent") : ElectricalPowerMeasurementServer);
    }
    if (caps.energy) {
        const {ElectricalEnergyMeasurementServer} = await import("@matter/main/behaviors/electrical-energy-measurement");
        behaviors.push(ElectricalEnergyMeasurementServer.with("ImportedEnergy", "CumulativeEnergy"));
    }

    return behaviors;
}

// biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
async function lightDefinition(base: PlanBase, light: MappingExpose, extras: readonly any[]): Promise<EndpointDefinitionPlan> {
    const features = light.features ?? [];
    const hasColor = features.some((f) => f.name === "color_xy" || f.name === "color_hs" || f.name === "color");
    const hasColorTemperature = features.some((f) => f.type === "numeric" && f.name === "color_temp");
    const dimmable = features.some((f) => f.type === "numeric" && f.name === "brightness");
    let path = dimmable ? "dimmable-light" : "on-off-light";
    let lightKind: "light" | "colorTemperature" | "color" = "light";
    if (hasColor) {
        path = "extended-color-light";
        lightKind = "color";
    } else if (hasColorTemperature) {
        path = "color-temperature-light";
        lightKind = "colorTemperature";
    }
    const device = await loadDevice(path);

    return {...base, definition: device.with(...extras) as EndpointDefinition, lightKind};
}

async function coverDefinition(
    base: PlanBase,
    cover: MappingExpose,
    source: ZigbeeMatterEndpointSource,
    // biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
    extras: readonly any[],
    report: (error: unknown) => void,
): Promise<EndpointDefinitionPlan> {
    const [{WindowCoveringDevice}, {WindowCoveringServer, MovementDirection, MovementType}] = await Promise.all([
        import("@matter/main/devices/window-covering"),
        import("@matter/main/behaviors/window-covering"),
    ]);
    const supportsTilt = cover.features?.some((feature) => feature.type === "numeric" && feature.name === "tilt") ?? false;
    const features = supportsTilt ? ["Lift", "PositionAwareLift", "Tilt", "PositionAwareTilt"] : ["Lift", "PositionAwareLift"];
    const invert = source.invertCover === true;
    const {send} = source;
    const dispatch = (payload: Record<string, unknown>): void => {
        void send(payload).catch(report);
    };
    // 이동/정지 명령은 StopMotion 포함 Matter command를 서버 핸들러에서 받아 Zigbee로 보낸다.
    // biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
    class ZigbeeWindowCoveringServer extends WindowCoveringServer.with(...(features as any)) {
        // biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
        public override handleMovement(type: any, _reversed: boolean, direction: any, target?: number): void {
            const key = type === MovementType.Tilt ? "tilt" : "position";
            if (target !== undefined) dispatch({[key]: matterPercent100thsToZigbee(target, invert)});
            else if (type === MovementType.Lift && direction !== MovementDirection.DefinedByPosition) {
                dispatch({state: direction === MovementDirection.Open ? "OPEN" : "CLOSE"});
            }
        }

        public override handleStopMovement(): void {
            dispatch({state: "STOP"});
        }
    }

    return {...base, definition: WindowCoveringDevice.with(ZigbeeWindowCoveringServer, ...extras) as EndpointDefinition, supportsTilt};
}

// biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
async function thermostatDefinition(base: PlanBase, thermostat: MappingExpose, extras: readonly any[]): Promise<EndpointDefinitionPlan> {
    const [{ThermostatDevice}, {ThermostatServer}] = await Promise.all([
        import("@matter/main/devices/thermostat"),
        import("@matter/main/behaviors/thermostat"),
    ]);
    const featureList = thermostat.features ?? [];
    const modes = featureList.find((feature) => feature.type === "enum" && feature.name === "system_mode")?.values ?? [];
    const has = (name: string): boolean => featureList.some((feature) => feature.name === name);
    const supportsHeating = modes.includes("heat") || modes.includes("emergency_heating") || has("occupied_heating_setpoint");
    const supportsCooling = modes.includes("cool") || has("occupied_cooling_setpoint");
    const features: string[] = [];
    if (supportsHeating) features.push("Heating");
    if (supportsCooling) features.push("Cooling");
    if (featureList.some((feature) => feature.name?.startsWith("unoccupied_"))) features.push("Occupancy");
    if (modes.includes("auto") && supportsHeating && supportsCooling) features.push("AutoMode");
    if (!supportsHeating && !supportsCooling) throw new Error("Matter thermostat mapping requires heating or cooling support");

    const setpointRanges: Record<string, SetpointRange> = {};
    for (const feature of featureList) {
        const {name, value_min: min, value_max: max} = feature;
        if (name !== undefined && min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max)) {
            setpointRanges[name] = {min, max};
        }
    }

    return {
        ...base,
        // biome-ignore lint/suspicious/noExplicitAny: Matter SDK variadic arguments require untyped generics
        definition: ThermostatDevice.with(ThermostatServer.with(...(features as any)), ...extras) as EndpointDefinition,
        setpointRanges,
        supportedModes: modes,
    };
}

function lightPatch(plan: EndpointDefinitionPlan, state: Record<string, unknown>, patch: Record<string, unknown>, guard: Guard): void {
    if (typeof state.brightness === "number") {
        const {brightness} = state;
        guard("brightness", () => {
            patch.levelControl = {currentLevel: zigbeeBrightnessToMatter(brightness).level};
        });
    }
    if (plan.lightKind === "colorTemperature" && typeof state.color_temp === "number") {
        const mireds = state.color_temp;
        guard("color_temp", () => {
            patch.colorControl = {colorTemperatureMireds: validateColorTemperatureMireds(mireds)};
        });
    }
    if (plan.lightKind !== "color") return;

    const color = state.color;
    guard("color", () => {
        if (isRecord(color) && typeof color.hue === "number" && typeof color.saturation === "number") {
            const mapped = zigbeeColorToMatter(color.hue, color.saturation);
            patch.colorControl = {currentHue: mapped.hue, currentSaturation: mapped.saturation};
        } else if (isRecord(color) && typeof color.x === "number" && typeof color.y === "number") {
            const mapped = zigbeeColorXyToMatter(color.x, color.y);
            patch.colorControl = {currentX: mapped.x, currentY: mapped.y};
        }
    });
}

function coverPatch(runtime: EndpointRuntime, state: Record<string, unknown>, patch: Record<string, unknown>, guard: Guard): void {
    const invert = runtime.source.invertCover === true;
    const windowCovering: Record<string, unknown> = {};
    // null(위치 미상) -> Matter currentPosition*Percent100ths는 nullable이므로 null.
    if (typeof state.position === "number" || state.position === null) {
        const {position} = state;
        guard("position", () => {
            runtime.coverPositions.lift = position === null ? undefined : zigbeeToMatterPercent100ths(position, invert);
            windowCovering.currentPositionLiftPercent100ths = runtime.coverPositions.lift ?? null;
        });
    }
    if (runtime.plan.supportsTilt && (typeof state.tilt === "number" || state.tilt === null)) {
        const {tilt} = state;
        guard("tilt", () => {
            runtime.coverPositions.tilt = tilt === null ? undefined : zigbeeToMatterPercent100ths(tilt, invert);
            windowCovering.currentPositionTiltPercent100ths = runtime.coverPositions.tilt ?? null;
        });
    }
    if (Object.keys(windowCovering).length > 0) patch.windowCovering = windowCovering;
}

/** expose unit을 읽어 Matter 단위(mW, mWh, mV, mA)로 환산한다. null은 nullable 속성이므로 null로 둔다. */
function electricalPatch(caps: Capabilities, state: Record<string, unknown>, patch: Record<string, unknown>, guard: Guard): void {
    const power: Record<string, unknown> = {};
    const convert = (quantity: "power" | "voltage" | "current", expose: MappingExpose | undefined, attribute: string): void => {
        const value = state[quantity];
        if (expose === undefined || (typeof value !== "number" && value !== null)) return;
        guard(quantity, () => {
            power[attribute] = value === null ? null : toMatterElectrical(quantity, value, expose.unit);
        });
    };
    convert("power", caps.power, "activePower");
    convert("voltage", caps.voltage, "rmsVoltage");
    convert("current", caps.current, "rmsCurrent");
    if (Object.keys(power).length > 0) patch.electricalPowerMeasurement = power;
    const energy = state.energy;
    if (caps.energy !== undefined && (typeof energy === "number" || energy === null)) {
        guard("energy", () => {
            patch.electricalEnergyMeasurement = {
                cumulativeEnergyImported: energy === null ? null : {energy: toMatterElectrical("energy", energy, caps.energy?.unit)},
            };
        });
    }
}

function lockPatch(runtime: EndpointRuntime, state: Record<string, unknown>, patch: Record<string, unknown>): void {
    const lockState = zigbeeLockStateToMatter(state.lock_state ?? state.state);
    if (lockState === undefined) return;

    patch.doorLock = {lockState};
    if (lockState === 1 || lockState === 2) runtime.lockOutcome = resolveLockOutcome(lockState === 1);
}

function thermostatPatch(plan: EndpointDefinitionPlan, state: Record<string, unknown>, patch: Record<string, unknown>, guard: Guard): void {
    const thermostat: Record<string, unknown> = {};
    // localTemperature만 nullable: null이면 null, 나머지 setpoint/mode는 null이면 이전 값을 유지한다.
    if (typeof state.local_temperature === "number" || state.local_temperature === null) {
        const local = state.local_temperature;
        guard("local_temperature", () => {
            const mapped = celsiusToMatter(local);
            thermostat.localTemperature = mapped.known ? mapped.value : null;
        });
    }
    for (const [attribute, field] of Object.entries(SETPOINT_FIELDS)) {
        const value = state[field];
        if (typeof value !== "number") continue;

        guard(field, () => {
            const range = plan.setpointRanges[field];
            const mapped = range === undefined ? celsiusToMatter(value) : celsiusSetpointToMatter(value, range.min, range.max);
            if (mapped.known) thermostat[attribute] = mapped.value;
        });
    }
    guard("system_mode", () => {
        const systemMode = zigbeeSystemModeToMatter(state.system_mode);
        if (systemMode !== undefined) thermostat.systemMode = systemMode;
    });
    if (Object.keys(thermostat).length > 0) patch.thermostat = thermostat;
}

/**
 * 필수 속성 초기값. 근거(@matter/*@0.18.0 .d.ts): types/clusters/switch.d.ts(numberOfPositions, currentPosition, multiPressMax 필수),
 * node/behaviors/switch/SwitchServer.d.ts(longPressDelay/multiPressDelay는 MSL/MSM에서 REQUIRED, Duration은 ms 숫자),
 * types/clusters/electrical-power-measurement.d.ts(powerMode, numberOfMeasurementTypes, accuracy),
 * types/globals/MeasurementAccuracy.d.ts, MeasurementType.d.ts, electrical-energy-measurement.d.ts(accuracy).
 */
function initialClusterState(caps: Capabilities, rootIsSwitch: boolean): Record<string, unknown> {
    const init: Record<string, unknown> = {};
    // Switch 상태는 Switch behavior가 실제로 붙은 endpoint(버튼 전용 root)에만 넣는다. child part는 SWITCH_INITIAL_STATE를 쓴다.
    if (rootIsSwitch) init.switch = SWITCH_INITIAL_STATE;
    const types: number[] = [];
    if (caps.power !== undefined || caps.voltage !== undefined || caps.current !== undefined) types.push(5); // ActivePower(필수 속성)
    if (caps.voltage !== undefined) types.push(8); // RmsVoltage
    if (caps.current !== undefined) types.push(9); // RmsCurrent
    if (types.length > 0) {
        init.electricalPowerMeasurement = {
            powerMode: 0, // Unknown
            numberOfMeasurementTypes: types.length,
            accuracy: types.map((measurementType) => measurementAccuracy(measurementType)),
        };
    }
    if (caps.energy !== undefined) init.electricalEnergyMeasurement = {accuracy: measurementAccuracy(14)}; // ElectricalEnergy

    return init;
}

function measurementAccuracy(measurementType: number): Record<string, unknown> {
    const max = Number.MAX_SAFE_INTEGER;

    return {
        measurementType,
        measured: true,
        minMeasuredValue: 0,
        maxMeasuredValue: max,
        accuracyRanges: [{rangeMin: 0, rangeMax: max}],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
