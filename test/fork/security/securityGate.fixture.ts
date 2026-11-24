import {evaluateSecurityGate, type SecurityGateInput, type SecurityGateStatus} from "../../../lib/security/securityGate";

const allEvidence = (
    ...requiredEvidence: SecurityGateInput["attestation"]["requiredEvidence"]
): SecurityGateInput["attestation"] => ({
    implemented: true,
    verified: true,
    requiredEvidence,
    evidence: requiredEvidence,
});

const required = {
    attestation: ["attestation-policy"] as const,
    apiAuth: ["api-auth-policy"] as const,
    backupEncryption: ["backup-encryption"] as const,
    secretRedaction: ["secret-redaction"] as const,
    externalConverter: ["external-converter-trust"] as const,
    dependencyAudit: ["dependency-audit"] as const,
};

export interface SecurityGateFixture {
    name: string;
    input: SecurityGateInput;
    expected: SecurityGateStatus;
}

export const securityGateFixtures: readonly SecurityGateFixture[] = [
    {
        name: "all checks pass only with explicit evidence",
        input: {
            attestation: allEvidence(...required.attestation),
            apiAuth: allEvidence(...required.apiAuth),
            backupEncryption: allEvidence(...required.backupEncryption),
            secretRedaction: allEvidence(...required.secretRedaction),
            externalConverter: allEvidence(...required.externalConverter),
            dependencyAudit: allEvidence(...required.dependencyAudit),
        },
        expected: "PASS",
    },
    {
        name: "missing execution evidence stays not run",
        input: {
            attestation: {
                implemented: true,
                verified: true,
                requiredEvidence: required.attestation,
                evidence: [],
            },
            apiAuth: allEvidence(...required.apiAuth),
            backupEncryption: allEvidence(...required.backupEncryption),
            secretRedaction: allEvidence(...required.secretRedaction),
            externalConverter: allEvidence(...required.externalConverter),
            dependencyAudit: allEvidence(...required.dependencyAudit),
        },
        expected: "NOT RUN",
    },
    {
        name: "unimplemented policy fails closed",
        input: {
            attestation: {
                implemented: false,
                verified: false,
                requiredEvidence: required.attestation,
                evidence: [],
                violations: ["attestation policy is not implemented"],
            },
            apiAuth: allEvidence(...required.apiAuth),
            backupEncryption: allEvidence(...required.backupEncryption),
            secretRedaction: allEvidence(...required.secretRedaction),
            externalConverter: allEvidence(...required.externalConverter),
            dependencyAudit: allEvidence(...required.dependencyAudit),
        },
        expected: "FAIL",
    },
];

export interface SecurityGateFixtureEvaluation {
    name: string;
    expected: SecurityGateStatus;
    actual: SecurityGateStatus;
    passed: boolean;
}

/** Fork fixture의 기대 결과를 계산하는 순수 oracle. 테스트 실행은 호출자가 담당한다. */
export function evaluateSecurityGateFixtures(): readonly SecurityGateFixtureEvaluation[] {
    return securityGateFixtures.map(({name, input, expected}) => {
        const actual = evaluateSecurityGate(input).status;
        return {name, expected, actual, passed: actual === expected};
    });
}
