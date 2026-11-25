import {describe, expect, it} from "vitest";
import {recordPerformance, summarizeLatency, summarizeResources} from "../../../lib/quality/performance";

describe("T070 performance contract", () => {
    it("records latency and resource summaries without inventing samples", () => {
        const measurement = recordPerformance({
            path: "routing",
            scale: 50,
            samples: [
                {latencyMs: 1, cpuPercent: 10, ramMb: 20, rfTxCount: 2},
                {latencyMs: 5, cpuPercent: 30, ramMb: 40, rfTxCount: 3, failed: true},
                {latencyMs: 10, cpuPercent: 20, ramMb: 30, rfTxCount: 4},
            ],
        });

        expect(measurement.status).toBe("RECORDED");
        expect(measurement.latency).toMatchObject({sampleCount: 3, p50: 5, p95: 10, p99: 10});
        expect(measurement.resources).toMatchObject({attempts: 3, failures: 1, failureRate: 1 / 3, rfTxCount: 9});
    });

    it("rejects empty or invalid samples instead of returning a passing metric", () => {
        expect(() => summarizeLatency([])).toThrow();
        expect(() => summarizeResources([{latencyMs: 1, cpuPercent: 101}])).toThrow();
        expect(() => recordPerformance({path: "event", scale: 50, samples: []})).toThrow();
    });
});
