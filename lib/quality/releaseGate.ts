/** 단계별 증거를 합산하는 릴리스 게이트 (T075). */

export const RELEASE_PHASES = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];
export type GateStatus = "PASS" | "FAIL" | "NOT_RUN";

export interface PhaseEvidence {
    status: GateStatus;
    evidence: string;
    blockers?: readonly string[];
}

export interface ReleaseGateInput {
    phases: Readonly<Partial<Record<ReleasePhase, PhaseEvidence>>>;
    approvalsComplete: boolean;
}

export interface ReleaseGateResult {
    status: GateStatus;
    releaseAllowed: false | true;
    missing: readonly ReleasePhase[];
    blockers: readonly string[];
}

/** 증거가 없는 단계나 실행 미완료 단계를 성공으로 승격하지 않는다. */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
    const missing = RELEASE_PHASES.filter((phase) => input.phases[phase] === undefined);
    const blockers = [...missing.map((phase) => `${phase} evidence is missing`), ...Object.values(input.phases).flatMap((evidence) => evidence?.blockers ?? [])];
    if (!input.approvalsComplete) blockers.push("required approvals are incomplete");

    const statuses = RELEASE_PHASES.map((phase) => input.phases[phase]?.status);
    const status: GateStatus = statuses.some((value) => value === "FAIL")
        ? "FAIL"
        : missing.length > 0
          ? "NOT_RUN"
          : !input.approvalsComplete || statuses.some((value) => value === "NOT_RUN")
            ? "NOT_RUN"
            : "PASS";

    return {status, releaseAllowed: status === "PASS", missing, blockers};
}
