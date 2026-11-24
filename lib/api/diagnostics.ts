/** 소비자별 메시지 진단 집계(T055). */
import type {PlatformConsumerStats} from "../events";

export interface ConsumerDiagnostic extends PlatformConsumerStats {
    id: string;
    platform: string;
    latencyMs?: number;
    lastError?: string;
}

export interface DiagnosticSnapshot {
    generatedAt: number;
    consumers: ConsumerDiagnostic[];
}

export class DiagnosticRegistry {
    private readonly consumers = new Map<string, ConsumerDiagnostic>();

    record(id: string, platform: string, stats: PlatformConsumerStats, latencyMs?: number, error?: unknown): void {
        if (!id) throw new Error("diagnostic id is required");
        if (![stats.queued, stats.dropped, stats.errors].every((value) => Number.isSafeInteger(value) && value >= 0)) {
            throw new Error("diagnostic counters must be non-negative safe integers");
        }
        if (latencyMs !== undefined && (!Number.isFinite(latencyMs) || latencyMs < 0)) throw new Error("diagnostic latency must be non-negative");
        this.consumers.set(id, {
            id,
            platform,
            ...stats,
            ...(latencyMs === undefined ? {} : {latencyMs}),
            ...(error === undefined ? {} : {lastError: error instanceof Error ? error.message : String(error)}),
        });
    }

    snapshot(now = Date.now()): DiagnosticSnapshot {
        if (!Number.isSafeInteger(now) || now < 0) throw new Error("diagnostic clock must be a non-negative safe integer");
        return {generatedAt: now, consumers: [...this.consumers.values()].map((consumer) => ({...consumer}))};
    }
}
