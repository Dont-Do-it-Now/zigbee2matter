/** HA Direct/Matter 공용 통합 경계(T049/T050/T051). */
import type {EntityKey} from "../identity";
import {HaEntityRegistry, type HaEntityPlatform} from "./haEntityRegistry";

export type HaIntegrationMode = "direct" | "matter" | "hybrid";
export type HaCommand = {entity: EntityKey; service: string; data?: Record<string, unknown>};

export interface HaStateUpdate {
    readonly entity: EntityKey;
    readonly value: unknown;
    readonly revision: number;
    readonly observedAt: number;
}

export interface HaIntegrationCallbacks {
    /** HA에서 들어온 명령을 공통 Core command 경계로 전달한다. */
    readonly onCommand: (command: HaCommand) => Promise<void>;
}

export interface HaIntegrationAdapter {
    readonly mode: HaIntegrationMode;
    register(entity: EntityKey, platform: HaEntityPlatform, name: string): void;
    setAvailability(entity: EntityKey, available: boolean): void;
    send(command: HaCommand): Promise<void>;
    /** Direct/Matter adapter가 composition root의 명령 callback을 보관한다. */
    connect?(callbacks: HaIntegrationCallbacks): void;
    /** Core 상태를 해당 HA transport로 전달한다. */
    publishState?(update: HaStateUpdate): void;
}

export interface CallbackHaIntegrationAdapterOptions {
    readonly onCommand: (command: HaCommand) => Promise<void>;
    readonly onRegister?: (entity: EntityKey, platform: HaEntityPlatform, name: string) => void;
    readonly onAvailability?: (entity: EntityKey, available: boolean) => void;
    readonly onState?: (update: HaStateUpdate) => void;
}

/** In-process adapter used by the Direct and Matter composition roots. */
export class CallbackHaIntegrationAdapter implements HaIntegrationAdapter {
    readonly mode: HaIntegrationMode;

    constructor(mode: Exclude<HaIntegrationMode, "hybrid">, private options: CallbackHaIntegrationAdapterOptions) {
        this.mode = mode;
    }

    register(entity: EntityKey, platform: HaEntityPlatform, name: string): void {
        this.options.onRegister?.(entity, platform, name);
    }

    setAvailability(entity: EntityKey, available: boolean): void {
        this.options.onAvailability?.(entity, available);
    }

    send(command: HaCommand): Promise<void> {
        return this.options.onCommand(command);
    }

    connect(callbacks: HaIntegrationCallbacks): void {
        this.options = {...this.options, onCommand: callbacks.onCommand};
    }

    publishState(update: HaStateUpdate): void {
        this.options.onState?.(update);
    }
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

    connect(mode: HaIntegrationMode, callbacks: HaIntegrationCallbacks): void {
        const adapter = this.adapters.get(mode);
        if (!adapter) throw new Error(`HA integration is not configured: ${mode}`);
        if (!adapter.connect) throw new Error(`HA integration does not support callbacks: ${mode}`);

        adapter.connect(callbacks);
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

    publishState(mode: HaIntegrationMode, entity: EntityKey, value: unknown, observedAt = Date.now()): void {
        const adapter = this.adapters.get(mode);
        if (!adapter) throw new Error(`HA integration is not configured: ${mode}`);

        const record = this.registry.setState(entity, value, observedAt);
        if (!record?.state) throw new Error(`HA entity is not registered: ${record?.uniqueId ?? "unknown"}`);
        adapter.publishState?.({entity, value: record.state.value, revision: record.state.revision, observedAt: record.state.observedAt});
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
