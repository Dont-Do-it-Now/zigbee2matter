/**
 * Converter expose -> Matter capability 판정 (T041).
 *
 * Matter SDK를 import하지 않는다. 표준 cluster/device type 규칙은 호출자가
 * 등록하고, 동적 exposes가 바뀔 때마다 현재 입력으로 다시 평가한다.
 */

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
        const flattened = flattenExposes(exposes, context.endpoint);

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

export function validateMappedNumber(value: unknown, range?: {min: number; max: number}): boolean {
    return typeof value === "number" && Number.isFinite(value) && (range === undefined || (value >= range.min && value <= range.max));
}

function flattenExposes(exposes: readonly MappingExpose[], endpoint?: string): MappingExpose[] {
    const result: MappingExpose[] = [];

    for (const expose of exposes) {
        const endpointMatches = expose.endpoint === undefined || expose.endpoint === endpoint;
        if (endpointMatches) {
            result.push(expose);
            if (expose.features !== undefined) result.push(...flattenExposes(expose.features, endpoint));
        }
    }

    return result;
}
