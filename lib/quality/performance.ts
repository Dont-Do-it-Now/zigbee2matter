/** T070 성능 측정 계약. 실제 benchmark 실행이나 장치 접근은 하지 않는다. */

export const PERFORMANCE_PATHS = ["event", "routing", "scheduling"] as const;
export const PERFORMANCE_SCALES = [50, 100, 250, 500] as const;

export type PerformancePath = (typeof PERFORMANCE_PATHS)[number];
export type PerformanceScale = (typeof PERFORMANCE_SCALES)[number];
export type MeasurementStatus = "NOT_RUN" | "RECORDED";

export interface PerformanceEnvironment {
    upstreamSha?: string;
    nodeVersion?: string;
    pnpmVersion?: string;
    sdkVersions?: Readonly<Record<string, string>>;
    hardware?: string;
    coordinator?: string;
    channel?: number;
    firmware?: string;
    location?: string;
}

export interface LatencySummary {
    sampleCount: number;
    unit: "ms";
    p50: number;
    p95: number;
    p99: number;
}

export interface ResourceSummary {
    cpuPercent?: number;
    ramMb?: number;
    rfTxCount?: number;
    attempts?: number;
    failures?: number;
    failureRate?: number;
}

export interface PerformanceMeasurement {
    path: PerformancePath;
    scale: PerformanceScale;
    status: MeasurementStatus;
    latency?: LatencySummary;
    resources?: ResourceSummary;
    environment?: PerformanceEnvironment;
    notes?: ReadonlyArray<string>;
}

export interface PerformancePlan {
    status: "NOT_RUN";
    metrics: ReadonlyArray<"latency" | "cpu" | "ram" | "failureRate" | "rfTxCount">;
    measurements: ReadonlyArray<PerformanceMeasurement>;
}

export interface PerformanceSample {
    latencyMs: number;
    cpuPercent?: number;
    ramMb?: number;
    rfTxCount?: number;
    failed?: boolean;
}

const METRICS = ["latency", "cpu", "ram", "failureRate", "rfTxCount"] as const;

/** 실행자가 채워야 하는 12개(path × scale) 측정 계획을 만든다. */
export function createPerformancePlan(): PerformancePlan {
    const measurements: PerformanceMeasurement[] = [];

    for (const path of PERFORMANCE_PATHS) {
        for (const scale of PERFORMANCE_SCALES) {
            measurements.push({path, scale, status: "NOT_RUN"});
        }
    }

    return {status: "NOT_RUN", metrics: METRICS, measurements};
}

/** 기록된 latency 표본으로 nearest-rank p50/p95/p99를 계산한다. */
export function summarizeLatency(samples: ReadonlyArray<number>): LatencySummary {
    if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error("latency samples must be finite non-negative numbers");
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const percentile = (ratio: number): number => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];

    return {
        sampleCount: sorted.length,
        unit: "ms",
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
    };
}

/** 수집된 시도 표본의 자원·RF·실패율을 요약한다. */
export function summarizeResources(samples: ReadonlyArray<PerformanceSample>): ResourceSummary {
    if (samples.length === 0) {
        throw new Error("resource samples must not be empty");
    }

    const failures = samples.filter((sample) => sample.failed === true).length;
    const average = (values: ReadonlyArray<number>): number | undefined =>
        values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
    const cpu = samples.flatMap((sample) => (sample.cpuPercent === undefined ? [] : [sample.cpuPercent]));
    const ram = samples.flatMap((sample) => (sample.ramMb === undefined ? [] : [sample.ramMb]));
    const rf = samples.flatMap((sample) => (sample.rfTxCount === undefined ? [] : [sample.rfTxCount]));

    if (
        samples.some((sample) =>
            [sample.cpuPercent, sample.ramMb, sample.rfTxCount].some(
                (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
            ),
        ) || samples.some((sample) => sample.cpuPercent !== undefined && sample.cpuPercent > 100)
    ) {
        throw new Error("resource samples must be finite non-negative numbers");
    }

    return {
        cpuPercent: average(cpu),
        ramMb: average(ram),
        rfTxCount: rf.length === 0 ? undefined : rf.reduce((sum, value) => sum + value, 0),
        attempts: samples.length,
        failures,
        failureRate: failures / samples.length,
    };
}
