/** T073 보안 게이트. 외부 상태·SDK·비밀값을 읽지 않는 순수 판정 모듈. */

export type SecurityGateStatus = "PASS" | "FAIL" | "NOT RUN";

export type SecurityCheckId =
    | "attestation-policy"
    | "api-auth-policy"
    | "backup-encryption"
    | "secret-redaction"
    | "external-converter-trust"
    | "dependency-audit";

export interface SecurityCheckInput {
    /** 해당 정책/구현이 현재 코드에 존재하는지 여부. */
    implemented: boolean;
    /** 권한 우회·비밀 유출·손상 입력 등의 실행 검증을 통과했는지 여부. */
    verified: boolean;
    /** PASS를 주장하기 위해 확인되어야 하는 비밀 없는 근거 ID. */
    requiredEvidence: readonly SecurityCheckId[];
    /** 실제로 확인된 근거 ID. 실행 결과나 승인된 정적 분석 결과만 넣는다. */
    evidence: readonly SecurityCheckId[];
    /** 정책 위반 사유. 비밀값 자체를 넣지 않는다. */
    violations?: readonly string[];
}

export interface SecurityGateInput {
    attestation: SecurityCheckInput;
    apiAuth: SecurityCheckInput;
    backupEncryption: SecurityCheckInput;
    secretRedaction: SecurityCheckInput;
    externalConverter: SecurityCheckInput;
    dependencyAudit: SecurityCheckInput;
}

export interface SecurityCheckResult {
    status: SecurityGateStatus;
    reasons: string[];
}

export interface SecurityGateResult {
    status: SecurityGateStatus;
    checks: {
        attestation: SecurityCheckResult;
        apiAuth: SecurityCheckResult;
        backupEncryption: SecurityCheckResult;
        secretRedaction: SecurityCheckResult;
        externalConverter: SecurityCheckResult;
        dependencyAudit: SecurityCheckResult;
    };
    reasons: string[];
}

function evaluateCheck(input: SecurityCheckInput): SecurityCheckResult {
    const violations = [...(input.violations ?? [])];
    if (violations.length > 0 || !input.implemented) {
        return {
            status: "FAIL",
            reasons: violations.length > 0 ? violations : ["required security policy is not implemented"],
        };
    }
    if (!input.verified) {
        return {status: "NOT RUN", reasons: ["required security verification is NOT RUN"]};
    }
    if (input.requiredEvidence.length === 0) {
        return {status: "NOT RUN", reasons: ["required security evidence is not declared"]};
    }
    const missingEvidence = input.requiredEvidence.filter((id) => !input.evidence.includes(id));
    if (missingEvidence.length > 0) {
        return {
            status: "NOT RUN",
            reasons: [`missing security evidence: ${missingEvidence.join(", ")}`],
        };
    }
    return {status: "PASS", reasons: []};
}

/**
 * 여섯 보안 영역을 fail-closed로 집계한다.
 * 실행 검증이 없는 상태에서는 PASS를 반환하지 않는다.
 */
export function evaluateSecurityGate(input: SecurityGateInput): SecurityGateResult {
    const checks = {
        attestation: evaluateCheck(input.attestation),
        apiAuth: evaluateCheck(input.apiAuth),
        backupEncryption: evaluateCheck(input.backupEncryption),
        secretRedaction: evaluateCheck(input.secretRedaction),
        externalConverter: evaluateCheck(input.externalConverter),
        dependencyAudit: evaluateCheck(input.dependencyAudit),
    };
    const results = Object.values(checks);
    const reasons = results.flatMap((result) => result.reasons);
    const status: SecurityGateStatus = results.some((result) => result.status === "FAIL")
        ? "FAIL"
        : results.some((result) => result.status === "NOT RUN")
          ? "NOT RUN"
          : "PASS";
    return {status, checks, reasons};
}
