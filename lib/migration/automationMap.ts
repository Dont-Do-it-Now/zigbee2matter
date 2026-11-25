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
        if (!mapping.legacyEntityId || byLegacy.has(mapping.legacyEntityId))
            throw new Error(`duplicate legacy entity mapping: ${mapping.legacyEntityId}`);
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

export interface AutomationSource {
    readonly automationId: string;
    /** HA 자동화/스크립트/씬 YAML 또는 z2m 설정 텍스트. 파일 읽기는 호출자가 수행한다. */
    readonly text: string;
}

const ENTITY_RE =
    /\b(light|switch|sensor|binary_sensor|cover|climate|fan|lock|select|number|button|event|update|group|scene|script|automation)\.([a-z0-9_]+)\b/g;
const SERVICE_RE = /^\s*(?:-\s*)?(?:service|action)\s*:\s*([a-z_]+\.[a-z0-9_]+)\s*$/gm;
const TOPIC_RE = /\bzigbee2mqtt\/([A-Za-z0-9_\-ㄱ-힝 ]+?)(?=\/|["'\s]|$)/g;

/** T066 수집기: 텍스트에서 entity_id, service, zigbee2mqtt/<이름> topic 참조를 찾는다. 추정·치환은 하지 않는다. */
export function scanAutomationReferences(sources: readonly AutomationSource[]): AutomationReference[] {
    const found = new Map<string, AutomationReference>();
    const add = (automationId: string, entityId: string, kind: AutomationReference["kind"]): void => {
        found.set(`${automationId}\u0000${entityId}`, {automationId, entityId, kind});
    };
    for (const {automationId, text} of sources) {
        const services = new Set<string>();
        for (const match of text.matchAll(SERVICE_RE)) {
            services.add(match[1]);
            add(automationId, match[1], "service");
        }
        for (const match of text.matchAll(ENTITY_RE)) {
            const id = `${match[1]}.${match[2]}`;
            if (services.has(id)) continue;
            add(automationId, id, match[1] === "group" ? "group" : match[1] === "scene" ? "scene" : "device");
        }
        for (const match of text.matchAll(TOPIC_RE)) {
            if (match[1] !== "bridge") add(automationId, `zigbee2mqtt/${match[1].trim()}`, "device");
        }
    }
    return [...found.values()];
}

/**
 * missing 참조에 대해 신규 entity 후보(object_id 일치)를 제안한다.
 * 제안은 항상 "ambiguous"이며 사용자가 검토 후 "mapped"로 확정하기 전에는 위험으로 유지된다(ID 자동 보존 보장 없음).
 */
export function proposeMappings(map: readonly EntityMapping[], newEntityIds: readonly string[]): EntityMapping[] {
    const objectId = (id: string): string => id.split(/[./]/).pop() ?? id;
    return map.map((entry) => {
        if (entry.status !== "missing") return entry;
        const candidates = newEntityIds.filter((id) => objectId(id) === objectId(entry.legacyEntityId));
        return candidates.length === 0 ? entry : {...entry, status: "ambiguous", directEntityId: candidates.length === 1 ? candidates[0] : undefined};
    });
}
