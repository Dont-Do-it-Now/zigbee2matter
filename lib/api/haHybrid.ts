/** HA Direct/Matter 중복 노출 및 모드 전환 정책(T051). */
import type {HaCommand, HaIntegrationMode} from "./haIntegration";
import {formatDeviceKey, formatGroupKey, parseEntityKey} from "../identity";

export interface HybridEntityBinding {
    readonly key: string;
    readonly directUniqueId?: string;
    readonly matterEndpoint?: number;
}

export interface HaHybridCallbacks {
    readonly onCommand: (mode: Exclude<HaIntegrationMode, "hybrid">, command: HaCommand) => Promise<void>;
}

export class HaHybridPolicy {
    private mode: HaIntegrationMode = "direct";
    private readonly bindings = new Map<string, HybridEntityBinding>();
    private callbacks?: HaHybridCallbacks;

    setMode(mode: HaIntegrationMode): void {
        if (mode !== "direct" && mode !== "matter" && mode !== "hybrid") throw new Error(`unsupported HA hybrid mode: ${mode}`);
        this.mode = mode;
    }

    getMode(): HaIntegrationMode {
        return this.mode;
    }

    connect(callbacks: HaHybridCallbacks): void {
        this.callbacks = callbacks;
    }

    async dispatchCommand(mode: Exclude<HaIntegrationMode, "hybrid">, command: HaCommand): Promise<void> {
        if (!this.callbacks) throw new Error("HA hybrid callbacks are not configured");
        const key = command.entity.kind === "device" ? formatDeviceKey(command.entity) : formatGroupKey(command.entity);
        if (!this.list(mode).some((binding) => binding.key === key)) {
            throw new Error(`HA hybrid entity is not exposed in mode: ${mode}`);
        }

        await this.callbacks.onCommand(mode, command);
    }

    bind(binding: HybridEntityBinding): void {
        if (!binding.key || parseEntityKey(binding.key) === undefined) throw new Error("hybrid entity key must be canonical");
        if (binding.directUniqueId !== undefined && binding.directUniqueId.length === 0) throw new Error("direct unique id is invalid");
        if (binding.matterEndpoint !== undefined && (!Number.isSafeInteger(binding.matterEndpoint) || binding.matterEndpoint < 1 || binding.matterEndpoint > 0xfffe)) {
            throw new Error("Matter endpoint must be an integer in 1..65534");
        }
        if (this.bindings.has(binding.key)) throw new Error(`duplicate hybrid entity key: ${binding.key}`);
        this.bindings.set(binding.key, {...binding});
    }

    list(mode = this.mode): HybridEntityBinding[] {
        return [...this.bindings.values()].filter((binding) => {
            if (mode === "hybrid") return true;
            return mode === "direct" ? binding.directUniqueId !== undefined : binding.matterEndpoint !== undefined;
        }).map((binding) => ({...binding}));
    }
}
