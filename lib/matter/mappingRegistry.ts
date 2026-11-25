/**
 * Converter expose -> Matter capability 판정 (T041).
 *
 * Matter SDK를 import하지 않는다. 표준 cluster/device type 규칙은 호출자가
 * 등록하고, 동적 exposes가 바뀔 때마다 현재 입력으로 다시 평가한다.
 */

import {deriveButtons} from "./buttonMapping";
import {isKnownElectricalUnit} from "./energyMapping";
import {classifyExposes, type FeatureDecision, type FeatureReference} from "./unsupportedFeatures";

export interface MappingExpose {
    type: string;
    name?: string;
    access?: number;
    unit?: string;
    value_min?: number;
    value_max?: number;
    values?: readonly string[];
    endpoint?: string;
    features?: readonly MappingExpose[];
}

export interface MappingRule {
    id: string;
    exposeType: string;
    featureName?: string;
    matterDeviceType: string;
    requiredClusters: readonly string[];
    requiredAccess?: number;
    unit?: string;
    range?: {min: number; max: number};
}

export interface MappingContext {
    endpoint?: string;
    /** true면 expose.endpoint 라벨로 거르지 않는다(호출자가 이미 Zigbee endpoint별로 나눈 경우). */
    anyEndpoint?: boolean;
    clusters: readonly string[];
}

export interface CapabilityMapping {
    ruleId: string;
    matterDeviceType: string;
    exposeName: string;
    supported: boolean;
    reason?: string;
}

export class MappingRegistry {
    private readonly rules = new Map<string, MappingRule>();

    constructor(rules: readonly MappingRule[] = []) {
        for (const rule of rules) this.register(rule);
    }

    register(rule: MappingRule): void {
        if (rule.id.length === 0 || this.rules.has(rule.id)) {
            throw new Error(`mapping rule id is already registered: ${rule.id}`);
        }
        if (rule.requiredClusters.length === 0 || rule.matterDeviceType.length === 0) {
            throw new Error(`mapping rule '${rule.id}' requires a device type and cluster`);
        }
        if (rule.range !== undefined && (rule.range.min > rule.range.max || !Number.isFinite(rule.range.min) || !Number.isFinite(rule.range.max))) {
            throw new Error(`mapping rule '${rule.id}' has an invalid range`);
        }

        this.rules.set(rule.id, {...rule, requiredClusters: [...rule.requiredClusters]});
    }

    evaluate(exposes: readonly MappingExpose[], context: MappingContext): CapabilityMapping[] {
        const flattened = flattenExposes(exposes, context.endpoint, context.anyEndpoint);

        return [...this.rules.values()].map((rule) => this.evaluateRule(rule, flattened, context));
    }

    private evaluateRule(rule: MappingRule, exposes: readonly MappingExpose[], context: MappingContext): CapabilityMapping {
        const expose = exposes.find((item) => item.type === rule.exposeType && (rule.featureName === undefined || item.name === rule.featureName));
        const exposeName = expose?.name ?? rule.featureName ?? rule.exposeType;

        if (expose === undefined) return this.unsupported(rule, exposeName, "matching expose is missing");
        if (rule.requiredAccess !== undefined && ((expose.access ?? 0) & rule.requiredAccess) !== rule.requiredAccess) {
            return this.unsupported(rule, exposeName, "required access is missing");
        }
        if (!rule.requiredClusters.every((cluster) => context.clusters.includes(cluster))) {
            return this.unsupported(rule, exposeName, "required cluster is missing");
        }
        if (rule.unit !== undefined && expose.unit !== rule.unit) {
            return this.unsupported(rule, exposeName, `unit must be '${rule.unit}'`);
        }
        if (rule.range !== undefined && (expose.value_min !== rule.range.min || expose.value_max !== rule.range.max)) {
            return this.unsupported(rule, exposeName, "expose range does not match the mapping rule");
        }

        return {ruleId: rule.id, matterDeviceType: rule.matterDeviceType, exposeName, supported: true};
    }

    private unsupported(rule: MappingRule, exposeName: string, reason: string): CapabilityMapping {
        return {ruleId: rule.id, matterDeviceType: rule.matterDeviceType, exposeName, supported: false, reason};
    }
}

function flattenExposes(exposes: readonly MappingExpose[], endpoint?: string, anyEndpoint = false): MappingExpose[] {
    const result: MappingExpose[] = [];

    for (const expose of exposes) {
        const endpointMatches = anyEndpoint || expose.endpoint === undefined || expose.endpoint === endpoint;
        if (endpointMatches) {
            result.push(expose);
            if (expose.features !== undefined) result.push(...flattenExposes(expose.features, endpoint, anyEndpoint));
        }
    }

    return result;
}

export type CapabilityId =
    | "light"
    | "switch"
    | "cover"
    | "lock"
    | "thermostat"
    | "button"
    | "temperature"
    | "humidity"
    | "contact"
    | "occupancy"
    | "power"
    | "energy"
    | "voltage"
    | "current";

/** 팩토리가 실제로 만들 수 있는 Matter cluster. 규칙의 requiredClusters 검증에 쓴다. */
export const SUPPORTED_MATTER_CLUSTERS: readonly string[] = [
    "OnOff",
    "LevelControl",
    "ColorControl",
    "WindowCovering",
    "Switch",
    "DoorLock",
    "Thermostat",
    "TemperatureMeasurement",
    "RelativeHumidityMeasurement",
    "BooleanState",
    "OccupancySensing",
    "ElectricalPowerMeasurement",
    "ElectricalEnergyMeasurement",
];

interface CapabilityRule extends MappingRule {
    capability: CapabilityId;
    /** 이 capability에 속하는 하위 feature 이름. 목록에 없는 하위 feature는 미지원으로 남는다. */
    nested?: readonly string[];
}

const DEFAULT_RULES: readonly CapabilityRule[] = [
    {
        id: "light",
        capability: "light",
        exposeType: "light",
        matterDeviceType: "Light",
        requiredClusters: ["OnOff"],
        nested: ["state", "brightness", "color_temp", "color_xy", "color_hs", "color", "x", "y", "hue", "saturation"],
    },
    {id: "switch", capability: "switch", exposeType: "switch", matterDeviceType: "OnOffPlugInUnit", requiredClusters: ["OnOff"], nested: ["state"]},
    {
        id: "cover",
        capability: "cover",
        exposeType: "cover",
        matterDeviceType: "WindowCovering",
        requiredClusters: ["WindowCovering"],
        nested: ["state", "position", "tilt"],
    },
    {
        id: "lock",
        capability: "lock",
        exposeType: "lock",
        matterDeviceType: "DoorLock",
        requiredClusters: ["DoorLock"],
        nested: ["state", "lock_state"],
    },
    {
        id: "thermostat",
        capability: "thermostat",
        exposeType: "climate",
        matterDeviceType: "Thermostat",
        requiredClusters: ["Thermostat"],
        nested: [
            "system_mode",
            "local_temperature",
            "occupied_heating_setpoint",
            "occupied_cooling_setpoint",
            "unoccupied_heating_setpoint",
            "unoccupied_cooling_setpoint",
        ],
    },
    {
        id: "button",
        capability: "button",
        exposeType: "enum",
        featureName: "action",
        matterDeviceType: "GenericSwitch",
        requiredClusters: ["Switch"],
    },
    {
        id: "temperature",
        capability: "temperature",
        exposeType: "numeric",
        featureName: "temperature",
        matterDeviceType: "TemperatureSensor",
        requiredClusters: ["TemperatureMeasurement"],
    },
    {
        id: "humidity",
        capability: "humidity",
        exposeType: "numeric",
        featureName: "humidity",
        matterDeviceType: "HumiditySensor",
        requiredClusters: ["RelativeHumidityMeasurement"],
    },
    {
        id: "contact",
        capability: "contact",
        exposeType: "binary",
        featureName: "contact",
        matterDeviceType: "ContactSensor",
        requiredClusters: ["BooleanState"],
    },
    // mmWave/radar 센서는 `occupancy` 대신 `presence`를 노출한다. 같은 capability에 매핑하며, 둘 다 있으면 뒤의 occupancy rule이 우선한다.
    {
        id: "presence",
        capability: "occupancy",
        exposeType: "binary",
        featureName: "presence",
        matterDeviceType: "OccupancySensor",
        requiredClusters: ["OccupancySensing"],
    },
    {
        id: "occupancy",
        capability: "occupancy",
        exposeType: "binary",
        featureName: "occupancy",
        matterDeviceType: "OccupancySensor",
        requiredClusters: ["OccupancySensing"],
    },
    {
        id: "power",
        capability: "power",
        exposeType: "numeric",
        featureName: "power",
        matterDeviceType: "ElectricalMeter",
        requiredClusters: ["ElectricalPowerMeasurement"],
    },
    {
        id: "energy",
        capability: "energy",
        exposeType: "numeric",
        featureName: "energy",
        matterDeviceType: "ElectricalMeter",
        requiredClusters: ["ElectricalEnergyMeasurement"],
    },
    {
        id: "voltage",
        capability: "voltage",
        exposeType: "numeric",
        featureName: "voltage",
        matterDeviceType: "ElectricalMeter",
        requiredClusters: ["ElectricalPowerMeasurement"],
    },
    {
        id: "current",
        capability: "current",
        exposeType: "numeric",
        featureName: "current",
        matterDeviceType: "ElectricalMeter",
        requiredClusters: ["ElectricalPowerMeasurement"],
    },
];

const UNIT_QUANTITY: Readonly<Partial<Record<CapabilityId, "power" | "energy" | "voltage" | "current">>> = {
    power: "power",
    energy: "energy",
    voltage: "voltage",
    current: "current",
};

export function createDefaultMappingRegistry(): MappingRegistry {
    return new MappingRegistry(DEFAULT_RULES.map(({capability: _capability, nested: _nested, ...rule}) => rule));
}

export interface PlanOptions {
    /** 기본 true. false면 라벨 없는 공용 expose를 이 endpoint에 매핑하지 않는다. */
    isPrimaryEndpoint?: boolean;
}

export interface EndpointMappingPlan {
    /** 매핑된 capability와 그 expose. 복합 기기는 여러 개가 한 endpoint에 들어간다. */
    capabilities: Partial<Record<CapabilityId, MappingExpose>>;
    mappings: CapabilityMapping[];
    /** 모든 expose의 분류(mapped/unsupported). */
    decisions: FeatureDecision[];
    /** 사용자/API 노출용 미지원 목록(2차 통합에서 연결). */
    unsupported: FeatureDecision[];
    /** button capability가 있을 때 버튼 식별자 목록(action enum values에서 도출). 단일 버튼은 [DEFAULT_BUTTON]. */
    buttons: string[];
}

/**
 * expose를 z2m endpoint 라벨(`l1`,`l2`,`left`...)별로 그룹화한다. 라벨 없는 expose는 키 ""(공용).
 * 컨트롤러는 Zigbee endpoint별(DeviceKey.endpoint)로 이미 나눠 넘기므로, 한 Matter endpoint 계획은 한 그룹만 받는다.
 */
export function groupExposesByEndpoint(exposes: readonly MappingExpose[]): Map<string, MappingExpose[]> {
    const groups = new Map<string, MappingExpose[]>();
    for (const expose of exposes) {
        const key = expose.endpoint ?? "";
        groups.set(key, [...(groups.get(key) ?? []), expose]);
    }

    return groups;
}

/** MappingRegistry + classifyExposes로 endpoint 매핑을 결정하는 단일 경로. */
export function planEndpointMapping(allExposes: readonly MappingExpose[], options: PlanOptions = {}): EndpointMappingPlan {
    // 라벨 없는 공용 expose(온도, 배터리, linkquality 등)는 대표 endpoint(가장 작은 Zigbee endpoint ID) 하나에만 매핑한다.
    // 근거: 같은 기기의 센서/전력 값이 endpoint 수만큼 중복 노출되지 않게 하며, ID 최소값은 기기 수명 동안 안정적이다.
    const exposes = options.isPrimaryEndpoint === false ? allExposes.filter((expose) => expose.endpoint !== undefined) : allExposes;
    const registry = createDefaultMappingRegistry();
    // 호출자가 Zigbee endpoint별로 이미 거른 exposes를 넘긴다: 라벨(l1/l2...)로 다시 버리지 않는다.
    const evaluated = registry.evaluate(exposes, {clusters: SUPPORTED_MATTER_CLUSTERS, anyEndpoint: true});
    const flattened = flattenExposes(exposes, undefined, true);
    const capabilities: Partial<Record<CapabilityId, MappingExpose>> = {};
    const mappings: CapabilityMapping[] = [];
    const mapped: FeatureReference[] = [];

    for (const rule of DEFAULT_RULES) {
        const mapping = evaluated.find((item) => item.ruleId === rule.id);
        const expose = flattened.find((item) => item.type === rule.exposeType && (rule.featureName === undefined || item.name === rule.featureName));
        if (mapping?.supported !== true || expose === undefined) continue;

        const quantity = UNIT_QUANTITY[rule.capability];
        if (quantity !== undefined && !isKnownElectricalUnit(quantity, expose.unit)) continue;
        // 배터리 기기의 `voltage`(mV)는 배터리 전압이지 AC 전력 측정이 아니다. ElectricalPowerMeasurement를 붙이면 endpoint 생성이 실패한다.
        if (rule.capability === "voltage" && flattened.some((item) => item.type === "numeric" && item.name === "battery")) continue;

        capabilities[rule.capability] = expose;
        mappings.push(mapping);
        collectMapped(expose, rule.nested ?? [], expose.endpoint, mapped);
    }

    const decisions = classifyExposes(exposes, mapped, []);

    const buttons = capabilities.button === undefined ? [] : deriveButtons(capabilities.button.values);

    return {capabilities, mappings, decisions, unsupported: decisions.filter((decision) => decision.disposition === "unsupported"), buttons};
}

function collectMapped(expose: MappingExpose, nested: readonly string[], endpoint: string | undefined, out: FeatureReference[]): void {
    out.push({type: expose.type, name: expose.name, endpoint});
    for (const feature of expose.features ?? []) {
        if (feature.name !== undefined && nested.includes(feature.name)) collectMapped(feature, nested, endpoint, out);
    }
}
