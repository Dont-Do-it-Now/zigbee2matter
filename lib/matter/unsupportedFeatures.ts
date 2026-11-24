/** 원본 expose의 Matter 지원 상태 추적 (T048). */

export interface UnsupportedExpose {
    type: string;
    name?: string;
    endpoint?: string;
    features?: readonly UnsupportedExpose[];
}

export type FeatureDisposition = "mapped" | "direct-only" | "unsupported";

export interface FeatureReference {
    type: string;
    name?: string;
    endpoint?: string;
}

export interface FeatureDecision extends FeatureReference {
    disposition: FeatureDisposition;
    reason: string;
}

export function featureKey(feature: FeatureReference): string {
    return `${feature.endpoint ?? ""}:${feature.type}:${feature.name ?? ""}`;
}

/** 모든 expose를 분류한다. 분류 목록에 없는 기능은 자동으로 unsupported다. */
export function classifyExposes(
    exposes: readonly UnsupportedExpose[],
    mapped: readonly FeatureReference[],
    directOnly: readonly FeatureReference[],
): FeatureDecision[] {
    const mappedKeys = new Set(mapped.map(featureKey));
    const directOnlyKeys = new Set(directOnly.map(featureKey));

    for (const key of mappedKeys) {
        if (directOnlyKeys.has(key)) throw new Error(`feature cannot be both mapped and direct-only: ${key}`);
    }

    return flatten(exposes).map((expose) => {
        const key = featureKey(expose);
        if (mappedKeys.has(key)) {
            return {...expose, disposition: "mapped", reason: "matched an approved Matter mapping"};
        }
        if (directOnlyKeys.has(key)) {
            return {...expose, disposition: "direct-only", reason: "kept in the original/UI path; no Matter equivalent"};
        }

        return {...expose, disposition: "unsupported", reason: "no approved Matter mapping"};
    });
}

function flatten(exposes: readonly UnsupportedExpose[], inheritedEndpoint?: string): FeatureReference[] {
    const result: FeatureReference[] = [];

    for (const expose of exposes) {
        const endpoint = expose.endpoint ?? inheritedEndpoint;
        result.push({type: expose.type, name: expose.name, endpoint});
        if (expose.features !== undefined) result.push(...flatten(expose.features, endpoint));
    }

    return result;
}
