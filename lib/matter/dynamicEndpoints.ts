/**
 * 동적 Matter endpoint 수명주기 계획 (T037).
 *
 * SDK를 직접 import하지 않는다. interview 성공 여부와 endpoint registry 순서를
 * 강제하고, 실제 SDK endpoint/Descriptor/PartsList 갱신은 adapter가 수행한다.
 */
import type {EndpointRegistry, EndpointRegistryEntry, RegistryKey} from "./endpointRegistry";

export interface EndpointCreatePlan {
    action: "create" | "reuse";
    entry: EndpointRegistryEntry;
}

export interface EndpointRemovePlan {
    action: "remove";
    entry: EndpointRegistryEntry;
}

export interface PartsListChange {
    partsList: number[];
    added: number[];
    removed: number[];
}

/** SDK endpoint를 만들거나 삭제하는 쪽이 registry 반영 시점을 명시하도록 한다. */
export class DynamicEndpointCoordinator {
    constructor(private readonly registry: EndpointRegistry) {}

    async prepareCreate(key: RegistryKey, interviewSuccessful: boolean): Promise<EndpointCreatePlan> {
        if (!interviewSuccessful) {
            throw new Error("dynamic endpoint requires a successful interview");
        }

        const existing = this.registry.get(key);
        if (existing !== undefined) {
            return {action: "reuse", entry: existing};
        }

        return {action: "create", entry: await this.registry.ensure(key)};
    }

    async recordCreated(key: RegistryKey, number: number): Promise<void> {
        await this.registry.recordNumber(key, number);
    }

    prepareRemove(key: RegistryKey): EndpointRemovePlan | undefined {
        const entry = this.registry.get(key);

        return entry === undefined ? undefined : {action: "remove", entry};
    }

    /** 실제 SDK endpoint 삭제와 topology 반영이 성공한 뒤 호출한다. */
    async completeRemove(key: RegistryKey): Promise<boolean> {
        return await this.registry.markRemoved(key);
    }
}

/** Descriptor PartsList를 중복 없이 계산한다. 충돌 입력은 조용히 보정하지 않는다. */
export function planPartsList(current: readonly number[], add: readonly number[], remove: readonly number[]): PartsListChange {
    const additions = uniqueEndpointNumbers(add, "add");
    const removals = uniqueEndpointNumbers(remove, "remove");
    const removeSet = new Set(removals);

    if (additions.some((endpoint) => removeSet.has(endpoint))) {
        throw new Error("PartsList add/remove overlap");
    }

    const currentSet = new Set(uniqueEndpointNumbers(current, "current"));
    for (const endpoint of removals) currentSet.delete(endpoint);
    for (const endpoint of additions) currentSet.add(endpoint);

    return {partsList: [...currentSet].sort((a, b) => a - b), added: additions, removed: removals};
}

function uniqueEndpointNumbers(values: readonly number[], field: string): number[] {
    const result = new Set<number>();

    for (const value of values) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 0xfffe) {
            throw new Error(`PartsList ${field} contains an invalid endpoint number`);
        }

        result.add(value);
    }

    return [...result];
}
