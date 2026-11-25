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

export interface DynamicEndpointAdapter {
    /** SDK endpoint를 생성하고 SDK가 할당한 실제 endpoint number를 반환한다. */
    create(entry: EndpointRegistryEntry): Promise<{number: number}>;
    /** SDK endpoint를 닫거나 영구 삭제한다. 성공 전에는 registry tombstone을 확정하지 않는다. */
    remove(entry: EndpointRegistryEntry): Promise<undefined | {permanent: boolean}>;
}

/** SDK endpoint를 만들거나 삭제하는 쪽이 registry 반영 시점을 명시하도록 한다. */
export class DynamicEndpointCoordinator {
    constructor(private readonly registry: EndpointRegistry) {}

    prepareRestore(key: RegistryKey): EndpointCreatePlan | undefined {
        const existing = this.registry.get(key);

        return existing === undefined ? undefined : {action: "reuse", entry: existing};
    }

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

export type EndpointMaterialization = "materialized" | "pending" | "failed" | "unknown";

/**
 * Registry 순서와 SDK endpoint adapter의 성공 순서를 하나의 실행 경계로 묶는다.
 *
 * registry entry(endpoint id)는 write-ahead로 먼저 남지만, SDK endpoint 생성 여부는 이 프로세스에서 따로 추적한다.
 * 생성이 실패한 entry는 "failed"로 남고, 같은 key로 다시 create/restore 하면 reuse가 아니라 실제 생성을 재시도한다.
 */
export class DynamicEndpointRuntime {
    private readonly materialized = new Set<string>();
    private readonly failed = new Map<string, string>();
    private readonly inflight = new Map<string, Promise<EndpointCreatePlan>>();

    constructor(
        private readonly coordinator: DynamicEndpointCoordinator,
        private readonly adapter: DynamicEndpointAdapter,
    ) {}

    /** 이 프로세스에서 SDK endpoint가 실제로 생성됐는지. */
    materialization(endpointId: string): EndpointMaterialization {
        if (this.materialized.has(endpointId)) return "materialized";
        if (this.inflight.has(endpointId)) return "pending";
        return this.failed.has(endpointId) ? "failed" : "unknown";
    }

    /** 마지막 생성 실패 사유(없으면 undefined). */
    lastFailure(endpointId: string): string | undefined {
        return this.failed.get(endpointId);
    }

    async create(key: RegistryKey, interviewSuccessful: boolean): Promise<EndpointCreatePlan> {
        const plan = await this.coordinator.prepareCreate(key, interviewSuccessful);
        if (plan.action === "reuse" && this.materialized.has(plan.entry.endpointId)) return plan;

        return await this.materialize(key, plan.entry, "create");
    }

    async restore(key: RegistryKey): Promise<EndpointCreatePlan | undefined> {
        const plan = this.coordinator.prepareRestore(key);
        if (plan === undefined) return undefined;
        if (this.materialized.has(plan.entry.endpointId)) return plan;

        return await this.materialize(key, plan.entry, "reuse");
    }

    async remove(key: RegistryKey): Promise<boolean> {
        const plan = this.coordinator.prepareRemove(key);
        if (plan === undefined) return false;

        const removal = await this.adapter.remove(plan.entry);
        this.materialized.delete(plan.entry.endpointId);
        this.failed.delete(plan.entry.endpointId);
        if (removal !== undefined && !removal.permanent) return false;
        return await this.coordinator.completeRemove(key);
    }

    /**
     * Replaces the live SDK endpoint with a freshly built one while keeping the registry entry (same endpointId, no tombstone).
     * The SDK delete drops the aggregator partsList entry first, so every fabric sees remove then re-add.
     */
    async rebuild(key: RegistryKey): Promise<EndpointCreatePlan | undefined> {
        const plan = this.coordinator.prepareRestore(key);
        if (plan === undefined) return undefined;

        await this.adapter.remove(plan.entry);
        this.materialized.delete(plan.entry.endpointId);
        this.failed.delete(plan.entry.endpointId);

        return await this.materialize(key, plan.entry, "reuse");
    }

    private materialize(key: RegistryKey, entry: EndpointRegistryEntry, action: EndpointCreatePlan["action"]): Promise<EndpointCreatePlan> {
        const running = this.inflight.get(entry.endpointId);
        if (running) return running;

        const task = this.runCreate(key, entry, action).finally(() => this.inflight.delete(entry.endpointId));
        this.inflight.set(entry.endpointId, task);
        return task;
    }

    private async runCreate(key: RegistryKey, entry: EndpointRegistryEntry, action: EndpointCreatePlan["action"]): Promise<EndpointCreatePlan> {
        let created: {number: number};
        try {
            created = await this.adapter.create(entry);
        } catch (error) {
            this.failed.set(entry.endpointId, error instanceof Error ? error.message : String(error));
            throw error;
        }

        try {
            await this.coordinator.recordCreated(key, created.number);
        } catch (error) {
            this.failed.set(entry.endpointId, error instanceof Error ? error.message : String(error));
            try {
                await this.adapter.remove(entry);
            } catch {
                // Preserve the registry error; diagnostics own cleanup reporting.
            }
            throw error;
        }

        this.failed.delete(entry.endpointId);
        this.materialized.add(entry.endpointId);
        return {action, entry: {...entry, number: created.number}};
    }
}
