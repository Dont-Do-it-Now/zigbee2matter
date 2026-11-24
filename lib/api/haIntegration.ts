/** HA Direct/Matter 공용 통합 경계(T049/T050/T051). */
import type {EntityKey} from "../identity";
import {HaEntityRegistry, type HaEntityPlatform} from "./haEntityRegistry";

export type HaIntegrationMode = "direct" | "matter" | "hybrid";
export type HaCommand = {entity: EntityKey; service: string; data?: Record<string, unknown>};

export interface HaIntegrationAdapter {
    readonly mode: HaIntegrationMode;
    register(entity: EntityKey, platform: HaEntityPlatform, name: string): void;
    setAvailability(entity: EntityKey, available: boolean): void;
    send(command: HaCommand): Promise<void>;
}

export class HaIntegrationRouter {
    private readonly adapters = new Map<HaIntegrationMode, HaIntegrationAdapter>();
    private readonly registry: HaEntityRegistry;

    constructor(registry = new HaEntityRegistry()) {
        this.registry = registry;
    }

    add(adapter: HaIntegrationAdapter): void {
        this.adapters.set(adapter.mode, adapter);
    }

    register(mode: HaIntegrationMode, entity: EntityKey, platform: HaEntityPlatform, name: string): void {
        const adapter = this.adapters.get(mode);
        if (!adapter) throw new Error(`HA integration is not configured: ${mode}`);
        this.registry.upsert(entity, platform, name);
        adapter.register(entity, platform, name);
    }

    setAvailability(mode: HaIntegrationMode, entity: EntityKey, available: boolean): void {
        const adapter = this.adapters.get(mode);
        if (!adapter) throw new Error(`HA integration is not configured: ${mode}`);
        this.registry.setAvailability(entity, available ? "available" : "unavailable");
        adapter.setAvailability(entity, available);
    }

    send(mode: HaIntegrationMode, command: HaCommand): Promise<void> {
        const adapter = this.adapters.get(mode);
        if (!adapter) return Promise.reject(new Error(`HA integration is not configured: ${mode}`));
        return adapter.send(command);
    }

    entities() {
        return this.registry.list();
    }
}
