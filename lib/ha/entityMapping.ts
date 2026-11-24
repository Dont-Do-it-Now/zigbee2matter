/**
 * HA 엔티티 매핑(T052, Q2). `lib/extension/homeassistant.ts`의 expose→platform 규칙과 lookup 테이블을 재사용하되
 * legacy HA discovery mapping의 송신부(topic/template)는 제외하고 JSON 직렬화 가능한 `HaEntityDefinition`만 만든다.
 * - unique_id/키는 C1 DeviceKey 기반(`zigbee2matter:dev:<net>:<ieee>:<ep>:ha/<platform>/<objectId>`), 이름·NWK 무관.
 * - 상태는 endpoint 별 상태 레코드(`dev:<net>:<ieee>:<ep>:state`)의 observedValue에서 `property`로 읽고,
 *   명령은 같은 stateKey를 target.key로 하고 `value={[commandProperty]: ...}`로 보낸다(endpoint 접미사 제외).
 * - `action` enum은 HA `event` 엔티티(device_class button)로 매핑한다(event_types=enum values, 기기당 1개).
 * - 그룹, composite/list/text는 미지원(생성하지 않음).
 */
import type * as zhc from "zigbee-herdsman-converters";
import {formatDeviceKey, makeDeviceKey, type EntityKey} from "../identity";
import {stableHaUniqueId, type HaEntityPlatform} from "../api/haEntityRegistry";
import {
    BINARY_DISCOVERY_LOOKUP,
    CONFIG_SWITCH_DISCOVERY_LOOKUP,
    ENUM_DISCOVERY_LOOKUP,
    NUMERIC_DISCOVERY_LOOKUP,
    SWITCH_DIFFERENT,
    cleanName,
} from "../extension/homeassistant";

const ACCESS_STATE = 0b001;
const ACCESS_SET = 0b010;

export interface HaEntityDefinition {
    readonly uniqueId: string;
    /** 엔티티 canonical key(`dev:...:ha/<platform>/<objectId>`). */
    readonly key: string;
    /** 상태 읽기/명령 target으로 쓰는 endpoint 상태 키(`dev:...:<ep>:state`). */
    readonly stateKey: string;
    readonly platform: HaEntityPlatform;
    readonly objectId: string;
    readonly name: string;
    /** Z2M endpoint label(예: `l1`). 없으면 device 전체. */
    readonly endpoint?: string;
    readonly endpointId: number;
    /** 상태 레코드 observedValue 안의 property(endpoint 접미사 제거됨). */
    readonly property?: string;
    /** 명령 payload에 쓰는 property(endpoint 접미사 제거됨). 읽기 전용이면 없음. */
    readonly commandProperty?: string;
    readonly deviceClass?: string;
    readonly unit?: string;
    readonly stateClass?: string;
    readonly entityCategory?: "config" | "diagnostic";
    readonly icon?: string;
    readonly enabledByDefault: boolean;
    /** Matter 브리지가 같은 기능을 이미 노출할 가능성이 높은 엔티티(Hybrid 중복 방지, T051). */
    readonly matterCovered: boolean;
    /** platform별 설정(light/climate/cover/lock/number/select/button/switch/binary_sensor). */
    readonly config: Readonly<Record<string, unknown>>;
}

export interface HaMapDeviceContext {
    readonly networkId: string;
    /** `0x...` 또는 16 hex. */
    readonly ieee: string;
    /** Z2M endpoint label(undefined=기본 endpoint) → Zigbee endpoint ID. 모르면 undefined(엔티티 생략). */
    readonly endpointId: (label: string | undefined) => number | undefined;
    /** Matter 엔드포인트 레지스트리 기반 실제 판정(선택). 없으면 platform 휴리스틱. */
    readonly matterCovered?: (definition: HaEntityDefinition) => boolean;
}

const MATTER_SENSOR_NAMES = new Set(["temperature", "humidity", "illuminance", "illuminance_lux", "pressure", "battery"]);
const MATTER_BINARY_NAMES = new Set(["occupancy", "contact", "water_leak", "smoke"]);

type Draft = Omit<HaEntityDefinition, "uniqueId" | "key" | "stateKey" | "endpointId" | "matterCovered" | "enabledByDefault"> & {
    enabledByDefault?: boolean;
};

/** device exposes 전체를 HA 엔티티 정의로 변환한다. 키를 만들 수 없는 expose는 건너뛴다. */
export function mapDeviceExposes(exposes: readonly zhc.Expose[], ctx: HaMapDeviceContext): HaEntityDefinition[] {
    const result: HaEntityDefinition[] = [];
    const seen = new Set<string>();
    const push = (draft: Draft): void => {
        const endpointId = ctx.endpointId(draft.endpoint);
        if (endpointId === undefined) return;
        const stateKeyObj = makeDeviceKey(ctx.networkId, ctx.ieee, endpointId, "state");
        const entityKeyObj = makeDeviceKey(ctx.networkId, ctx.ieee, endpointId, `ha/${draft.platform}/${draft.objectId}`);
        if (!stateKeyObj || !entityKeyObj) return;
        const entityKey: EntityKey = {kind: "device", ...entityKeyObj};
        const key = formatDeviceKey(entityKeyObj);
        if (seen.has(key)) return;
        seen.add(key);
        const definition: HaEntityDefinition = {
            ...draft,
            uniqueId: stableHaUniqueId(entityKey),
            key,
            stateKey: formatDeviceKey(stateKeyObj),
            endpointId,
            enabledByDefault: draft.enabledByDefault ?? true,
            matterCovered: false,
        };
        result.push({...definition, matterCovered: ctx.matterCovered ? ctx.matterCovered(definition) : defaultMatterCovered(definition)});
    };

    for (const expose of exposes) mapExpose(expose, push);

    return result;
}

/** 상태 레코드 observedValue에서 엔티티 값을 꺼낸다(없으면 undefined). */
export function entityValue(definition: HaEntityDefinition, observed: unknown): unknown {
    if (definition.property === undefined || typeof observed !== "object" || observed === null) return undefined;

    return (observed as Record<string, unknown>)[definition.property];
}

function mapExpose(expose: zhc.Expose, push: (draft: Draft) => void): void {
    const endpoint = expose.endpoint;
    const ep = endpoint ? `_${endpoint}` : "";
    const baseName = (label: string): string => (endpoint ? `${label} ${endpoint}` : label);
    const cap = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
    const prop = (feature: {property: string; endpoint?: string}): string => stripEndpoint(feature.property, feature.endpoint ?? endpoint);

    switch (expose.type) {
        case "light": {
            const features = (expose as zhc.Light).features;
            const state = features.find((f) => f.name === "state");
            if (!state) return;
            const hasXY = features.some((f) => f.name === "color_xy");
            const hasHS = features.some((f) => f.name === "color_hs");
            const brightness = features.some((f) => f.name === "brightness");
            const colorTemp = features.find((f) => f.name === "color_temp") as zhc.Numeric | undefined;
            const preferHS = hasXY && hasHS && features.findIndex((f) => f.name === "color_hs") < features.findIndex((f) => f.name === "color_xy");
            const colorModes = [
                hasXY && !preferHS ? "xy" : null,
                (!hasXY || preferHS) && hasHS ? "hs" : null,
                colorTemp ? "color_temp" : null,
            ].filter(
                (c): c is string => c !== null,
            );
            push({
                platform: "light",
                objectId: sanitize(endpoint ? `light_${endpoint}` : "light"),
                name: endpoint ? cap(endpoint) : "Light",
                endpoint,
                property: prop(state),
                commandProperty: prop(state),
                config: {
                    brightness,
                    colorModes: colorModes.length ? colorModes : ["brightness"],
                    ...(colorTemp?.value_min != null ? {minMireds: colorTemp.value_min} : {}),
                    ...(colorTemp?.value_max != null ? {maxMireds: colorTemp.value_max} : {}),
                    brightnessScale: 254,
                    onValue: "ON",
                    offValue: "OFF",
                },
            });
            return;
        }
        case "switch": {
            const state = (expose as zhc.Switch).features.find((f) => f.name === "state" && f.type === "binary") as zhc.Binary | undefined;
            if (!state) return;
            const property = prop(state);
            const different = SWITCH_DIFFERENT.includes(property);
            push({
                platform: "switch",
                objectId: sanitize(different ? property : endpoint ? `switch_${endpoint}` : "switch"),
                name: different ? expose.label : endpoint ? cap(endpoint) : "Switch",
                endpoint,
                property,
                commandProperty: property,
                ...(different ? pickMeta(CONFIG_SWITCH_DISCOVERY_LOOKUP[property]) : {}),
                config: {onValue: state.value_on, offValue: state.value_off},
            });
            return;
        }
        case "lock": {
            const state = (expose as zhc.Lock).features.find((f) => f.name === "state" && f.type === "binary") as zhc.Binary | undefined;
            if (!state) return;
            push({
                platform: "lock",
                objectId: sanitize(endpoint ? `lock_${endpoint}` : "lock"),
                name: endpoint ? cap(endpoint) : "Lock",
                endpoint,
                property: prop(state),
                commandProperty: prop(state),
                config: {lockedValue: state.value_on, unlockedValue: state.value_off},
            });
            return;
        }
        case "cover": {
            const features = (expose as zhc.Cover).features;
            const state = features.find((f) => f.name === "state");
            if (!state) return;
            const position = features.find((f) => f.name === "position");
            const tilt = features.find((f) => f.name === "tilt");
            push({
                platform: "cover",
                objectId: sanitize(endpoint ? `cover_${endpoint}` : "cover"),
                name: endpoint ? cap(endpoint) : "Cover",
                endpoint,
                property: prop(state),
                commandProperty: prop(state),
                config: {
                    openValue: "OPEN",
                    closeValue: "CLOSE",
                    stopValue: "STOP",
                    ...(position ? {positionProperty: prop(position)} : {}),
                    ...(tilt ? {tiltProperty: prop(tilt)} : {}),
                },
            });
            return;
        }
        case "climate": {
            const features = (expose as zhc.Climate).features;
            const numeric = features.filter((f): f is zhc.Numeric => f.type === "numeric");
            const heating = numeric.find((f) => ["occupied_heating_setpoint", "current_heating_setpoint"].includes(f.name));
            const cooling = numeric.find((f) => f.name === "occupied_cooling_setpoint");
            const primary = heating ?? cooling;
            const temperature = features.find((f) => f.name === "local_temperature");
            if (!primary || primary.value_min === undefined || primary.value_max === undefined || !temperature) return;
            const mode = features.find((f): f is zhc.Enum => f.type === "enum" && f.name === "system_mode");
            const running = features.find((f) => f.name === "running_state");
            const modes = mode?.values.map(String).filter((v) => v !== "sleep" && v !== "emergency_heating");
            push({
                platform: "climate",
                objectId: sanitize(endpoint ? `climate_${endpoint}` : "climate"),
                name: endpoint ? cap(endpoint) : "Climate",
                endpoint,
                property: prop(temperature),
                commandProperty: prop(primary),
                unit: "°C",
                config: {
                    minTemp: primary.value_min,
                    maxTemp: primary.value_max,
                    ...(primary.value_step !== undefined ? {step: primary.value_step} : {}),
                    currentTemperatureProperty: prop(temperature),
                    ...(heating ? {heatingSetpointProperty: prop(heating)} : {}),
                    ...(cooling ? {coolingSetpointProperty: prop(cooling)} : {}),
                    ...(mode ? {modeProperty: prop(mode), modes} : {}),
                    ...(running ? {runningStateProperty: prop(running)} : {}),
                },
            });
            return;
        }
        case "fan": {
            // fan은 전용 platform 없이 기능별 leaf 엔티티로 분해한다.
            for (const feature of (expose as zhc.Fan).features) {
                mapExpose({...(feature as zhc.Expose), endpoint: feature.endpoint ?? endpoint} as zhc.Expose, push);
            }
            return;
        }
        case "binary": {
            const e = expose as zhc.Binary;
            const meta = pickMeta(BINARY_DISCOVERY_LOOKUP[e.name]);
            if (e.access & ACCESS_SET) {
                push({
                    platform: "switch",
                    objectId: sanitize(`switch_${e.name}${ep}`),
                    name: baseName(e.label),
                    endpoint,
                    property: prop(e),
                    commandProperty: prop(e),
                    ...meta,
                    config: {onValue: e.value_on, offValue: e.value_off},
                });
            } else if (e.access & ACCESS_STATE) {
                push({
                    platform: "binary_sensor",
                    objectId: sanitize(`${e.name}${ep}`),
                    name: baseName(e.label),
                    endpoint,
                    property: prop(e),
                    ...meta,
                    config: {onValue: e.value_on, offValue: e.value_off},
                });
            }
            return;
        }
        case "numeric": {
            const e = expose as zhc.Numeric;
            if (e.access & ACCESS_SET) {
                const lookup = NUMERIC_DISCOVERY_LOOKUP[cleanName(e.name)];
                const meta = pickMeta(lookup);
                push({
                    platform: "number",
                    objectId: sanitize(`${e.name}${ep}`),
                    name: baseName(e.label),
                    endpoint,
                    property: e.access & ACCESS_STATE ? prop(e) : undefined,
                    commandProperty: prop(e),
                    ...meta,
                    // number는 temperature 외 device_class를 쓰지 않는다(homeassistant.ts와 동일).
                    deviceClass: lookup?.device_class === "temperature" ? "temperature" : undefined,
                    unit: e.unit,
                    config: {
                        ...(e.value_min != null ? {min: e.value_min} : {}),
                        ...(e.value_max != null ? {max: e.value_max} : {}),
                        ...(e.value_step ? {step: e.value_step} : {}),
                    },
                });
                return;
            }
            if (!(e.access & ACCESS_STATE)) return;
            const extra: {deviceClass?: string; stateClass?: string} = {};
            if (e.unit && ["Wh", "kWh"].includes(e.unit)) Object.assign(extra, {deviceClass: "energy", stateClass: "total_increasing"});
            else if (e.unit && ["A", "mA"].includes(e.unit)) Object.assign(extra, {deviceClass: "current", stateClass: "measurement"});
            else if (e.unit && ["mW", "W", "kW"].includes(e.unit)) Object.assign(extra, {deviceClass: "power", stateClass: "measurement"});
            const key = e.name === "voc" && e.unit && ["ppb", "ppm"].includes(e.unit) ? "voc_parts" : cleanName(e.name);
            const merged: ReturnType<typeof pickMeta> = {...pickMeta(NUMERIC_DISCOVERY_LOOKUP[key]), ...extra};
            // device_class가 있는데 단위가 없으면 HA 경고 → 제거. sensor에 config category는 불가 → diagnostic.
            const {deviceClass, entityCategory, ...rest} = merged;
            push({
                platform: "sensor",
                objectId: sanitize(`${e.name}${ep}`),
                name: baseName(e.label),
                endpoint,
                property: prop(e),
                ...rest,
                ...(deviceClass && e.unit ? {deviceClass} : {}),
                ...(entityCategory ? {entityCategory: entityCategory === "config" ? "diagnostic" : entityCategory} : {}),
                unit: e.unit,
                config: {},
            });
            return;
        }
        case "enum": {
            const e = expose as zhc.Enum;
            const meta = pickMeta(ENUM_DISCOVERY_LOOKUP[e.name]);
            // 'action'은 순간 이벤트이므로 상태 sensor 대신 event 엔티티로 노출한다(C4: transient 병합 금지).
            if (e.property === "action") {
                if (e.access & ACCESS_STATE) {
                    push({
                        platform: "event",
                        objectId: sanitize(`${e.property}${ep}`),
                        name: baseName(e.label),
                        endpoint,
                        property: prop(e),
                        deviceClass: "button",
                        config: {eventTypes: e.values.map(String)},
                    });
                }
                return;
            }
            if (e.access & ACCESS_SET) {
                if (e.values.length === 1) {
                    push({
                        platform: "button",
                        objectId: sanitize(`${e.property}${ep}`),
                        name: baseName(e.label),
                        endpoint,
                        commandProperty: prop(e),
                        ...meta,
                        config: {pressValue: String(e.values[0])},
                    });
                } else {
                    push({
                        platform: "select",
                        objectId: sanitize(`${e.property}${ep}`),
                        name: baseName(e.label),
                        endpoint,
                        property: e.access & ACCESS_STATE ? prop(e) : undefined,
                        commandProperty: prop(e),
                        ...meta,
                        config: {options: e.values.map(String)},
                    });
                }
                return;
            }
            if (e.access & ACCESS_STATE) {
                push({
                    platform: "sensor",
                    objectId: sanitize(`${e.property}${ep}`),
                    name: baseName(e.label),
                    endpoint,
                    property: prop(e),
                    ...meta,
                    config: {},
                });
            }
            return;
        }
        default:
            return; // text/composite/list: 미지원
    }
}

function stripEndpoint(property: string, endpoint: string | undefined): string {
    const suffix = endpoint ? `_${endpoint}` : "";
    return suffix && property.endsWith(suffix) ? property.slice(0, -suffix.length) : property;
}

function sanitize(value: string): string {
    return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function pickMeta(source: KeyValue | undefined): Pick<Draft, "deviceClass" | "stateClass" | "entityCategory" | "icon" | "enabledByDefault"> {
    if (!source) return {};
    const category = source.entity_category === "config" || source.entity_category === "diagnostic" ? source.entity_category : undefined;

    return {
        ...(typeof source.device_class === "string" ? {deviceClass: source.device_class} : {}),
        ...(typeof source.state_class === "string" ? {stateClass: source.state_class} : {}),
        ...(category ? {entityCategory: category} : {}),
        ...(typeof source.icon === "string" ? {icon: source.icon} : {}),
        ...(typeof source.enabled_by_default === "boolean" ? {enabledByDefault: source.enabled_by_default} : {}),
    };
}

function defaultMatterCovered(d: HaEntityDefinition): boolean {
    if (d.entityCategory) return false;
    switch (d.platform) {
        case "light":
        case "cover":
        case "lock":
        case "climate":
            return true;
        case "switch":
            return d.property === "state";
        case "sensor":
            return MATTER_SENSOR_NAMES.has(d.property ?? "");
        case "binary_sensor":
            return MATTER_BINARY_NAMES.has(d.property ?? "");
        default:
            return false;
    }
}
