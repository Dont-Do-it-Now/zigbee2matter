/** HA Direct/Matter 중복 노출 및 모드 전환 정책(T051). */
import type {HaIntegrationMode} from "./haIntegration";

export interface HybridEntityBinding {
    readonly key: string;
    readonly directUniqueId?: string;
    readonly matterEndpoint?: number;
}

export class HaHybridPolicy {
    private mode: HaIntegrationMode = "direct";
    private readonly bindings = new Map<string, HybridEntityBinding>();

    setMode(mode: HaIntegrationMode): void {
        this.mode = mode;
    }

    getMode(): HaIntegrationMode {
        return this.mode;
    }

    bind(binding: HybridEntityBinding): void {
        if (!binding.key) throw new Error("hybrid entity key is required");
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
