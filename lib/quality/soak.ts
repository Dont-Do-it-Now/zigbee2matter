/** T074 장시간 검증 계획과 기록 schema. 실제 장시간 실행은 하지 않는다. */

export const SOAK_STAGES = ["24h", "7d", "30d"] as const;

export type SoakStage = (typeof SOAK_STAGES)[number];
export type SoakStatus = "NOT_RUN" | "RECORDED";

export interface SoakEnvironment {
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

export interface SoakStagePlan {
    stage: SoakStage;
    durationHours: number;
    controlIntervalMinutes: number;
    reconnectCases: number;
    requiredMetrics: readonly ["control", "reconnect", "memory", "errorRate"];
}

export interface SoakPlan {
    status: "NOT_RUN";
    environment?: SoakEnvironment;
    stages: ReadonlyArray<SoakStagePlan>;
}

export interface MemorySample {
    elapsedHours: number;
    rssMb: number;
    heapUsedMb?: number;
}

export interface SoakRecord {
    stage: SoakStage;
    status: SoakStatus;
    durationHours: number;
    controlAttempts: number;
    controlFailures: number;
    reconnectAttempts: number;
    reconnectFailures: number;
    memory: ReadonlyArray<MemorySample>;
    errorCount: number;
    operationCount: number;
    environment?: SoakEnvironment;
    notes?: ReadonlyArray<string>;
}

export interface MemoryTrend {
    sampleCount: number;
    firstRssMb: number;
    lastRssMb: number;
    minimumRssMb: number;
    maximumRssMb: number;
    deltaRssMb: number;
    slopeMbPerHour: number;
}

export interface SoakSummary {
    stage: SoakStage;
    controlFailureRate: number;
    reconnectFailureRate: number;
    errorRate: number;
    memoryTrend: MemoryTrend;
}

export interface SoakValidation {
    valid: boolean;
    errors: ReadonlyArray<string>;
}

const STAGE_PLANS: ReadonlyArray<SoakStagePlan> = [
    {
        stage: "24h",
        durationHours: 24,
        controlIntervalMinutes: 15,
        reconnectCases: 1,
        requiredMetrics: ["control", "reconnect", "memory", "errorRate"],
    },
    {
        stage: "7d",
        durationHours: 24 * 7,
        controlIntervalMinutes: 30,
        reconnectCases: 3,
        requiredMetrics: ["control", "reconnect", "memory", "errorRate"],
    },
    {
        stage: "30d",
        durationHours: 24 * 30,
        controlIntervalMinutes: 60,
        reconnectCases: 10,
        requiredMetrics: ["control", "reconnect", "memory", "errorRate"],
    },
];

/** 24시간·7일·30일 장시간 검증 계획을 모두 미실행으로 만든다. */
export function createSoakPlan(environment?: SoakEnvironment): SoakPlan {
    return {
        status: "NOT_RUN",
        environment,
        stages: STAGE_PLANS.map((stage) => ({...stage, requiredMetrics: [...stage.requiredMetrics]})),
    };
}

function validateCount(name: string, value: number, errors: string[]): void {
    if (!Number.isInteger(value) || value < 0) errors.push(`${name} must be a non-negative integer`);
}

/** 실행자가 제출한 장시간 기록의 정적 계약만 검사한다. */
export function validateSoakRecord(record: SoakRecord): SoakValidation {
    const errors: string[] = [];
    const expected = STAGE_PLANS.find((plan) => plan.stage === record.stage);

    if (!expected) errors.push("unknown soak stage");
    if (record.status !== "RECORDED") errors.push("soak record must be RECORDED");
    if (!Number.isFinite(record.durationHours) || record.durationHours < 0) errors.push("duration must be finite and non-negative");
    validateCount("controlAttempts", record.controlAttempts, errors);
    validateCount("controlFailures", record.controlFailures, errors);
    validateCount("reconnectAttempts", record.reconnectAttempts, errors);
    validateCount("reconnectFailures", record.reconnectFailures, errors);
    validateCount("errorCount", record.errorCount, errors);
    validateCount("operationCount", record.operationCount, errors);

    if (record.controlFailures > record.controlAttempts) errors.push("control failures exceed attempts");
    if (record.reconnectFailures > record.reconnectAttempts) errors.push("reconnect failures exceed attempts");
    if (record.errorCount > record.operationCount) errors.push("errors exceed operations");
    if (expected && record.durationHours < expected.durationHours) errors.push("record duration is below planned stage");
    if (record.memory.length === 0) errors.push("memory samples must not be empty");

    for (const sample of record.memory) {
        if (!Number.isFinite(sample.elapsedHours) || sample.elapsedHours < 0) errors.push("memory elapsed time must be finite and non-negative");
        if (!Number.isFinite(sample.rssMb) || sample.rssMb < 0) errors.push("rss must be finite and non-negative");
        if (sample.heapUsedMb !== undefined && (!Number.isFinite(sample.heapUsedMb) || sample.heapUsedMb < 0)) {
            errors.push("heap used memory must be finite and non-negative");
        }
    }

    return {valid: errors.length === 0, errors};
}

/** 메모리 표본의 증가량과 시간당 추세를 계산한다. 표본이 없으면 성공값을 만들지 않는다. */
export function summarizeMemoryTrend(samples: ReadonlyArray<MemorySample>): MemoryTrend {
    if (samples.length === 0) throw new Error("memory samples must not be empty");

    const validation = samples.flatMap((sample) => {
        const errors: string[] = [];
        if (!Number.isFinite(sample.elapsedHours) || sample.elapsedHours < 0) errors.push("invalid elapsed time");
        if (!Number.isFinite(sample.rssMb) || sample.rssMb < 0) errors.push("invalid rss");
        return errors;
    });
    if (validation.length > 0) throw new Error(`invalid memory samples: ${validation.join(", ")}`);

    const ordered = [...samples].sort((left, right) => left.elapsedHours - right.elapsedHours);
    const rss = ordered.map((sample) => sample.rssMb);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const elapsed = last.elapsedHours - first.elapsedHours;

    return {
        sampleCount: ordered.length,
        firstRssMb: first.rssMb,
        lastRssMb: last.rssMb,
        minimumRssMb: Math.min(...rss),
        maximumRssMb: Math.max(...rss),
        deltaRssMb: last.rssMb - first.rssMb,
        slopeMbPerHour: elapsed === 0 ? 0 : (last.rssMb - first.rssMb) / elapsed,
    };
}

/** 제어·재접속·전체 작업의 실패율과 메모리 추세를 한 번에 요약한다. */
export function summarizeSoakRecord(record: SoakRecord): SoakSummary {
    const validation = validateSoakRecord(record);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    if (record.memory.length === 0) throw new Error("memory samples must not be empty");

    const rate = (failures: number, attempts: number): number => (attempts === 0 ? 0 : failures / attempts);
    return {
        stage: record.stage,
        controlFailureRate: rate(record.controlFailures, record.controlAttempts),
        reconnectFailureRate: rate(record.reconnectFailures, record.reconnectAttempts),
        errorRate: rate(record.errorCount, record.operationCount),
        memoryTrend: summarizeMemoryTrend(record.memory),
    };
}
