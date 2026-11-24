/** 기존 자동화 참조와 새 entity의 대응표(T066). */

export interface AutomationReference {
    readonly automationId: string;
    readonly entityId: string;
    readonly kind: "device" | "group" | "scene" | "service";
}

export interface EntityMapping {
    readonly legacyEntityId: string;
    readonly directEntityId?: string;
    readonly matterEndpoint?: string;
    readonly status: "mapped" | "missing" | "ambiguous";
}

export function buildAutomationMap(references: readonly AutomationReference[], mappings: readonly EntityMapping[]): EntityMapping[] {
    const byLegacy = new Map<string, EntityMapping>();
    for (const mapping of mappings) {
        if (!mapping.legacyEntityId || byLegacy.has(mapping.legacyEntityId)) throw new Error(`duplicate legacy entity mapping: ${mapping.legacyEntityId}`);
        byLegacy.set(mapping.legacyEntityId, {...mapping});
    }
    return references.map((reference) => {
        const mapping = byLegacy.get(reference.entityId);
        if (!mapping) return {legacyEntityId: reference.entityId, status: "missing"} satisfies EntityMapping;
        return {...mapping};
    });
}

export function findAutomationRisks(references: readonly AutomationReference[], map: readonly EntityMapping[]): string[] {
    const available = new Set(map.filter((entry) => entry.status === "mapped").map((entry) => entry.legacyEntityId));
    return [...new Set(references.filter((reference) => !available.has(reference.entityId)).map((reference) => reference.automationId))];
}
