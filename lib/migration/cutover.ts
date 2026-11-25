/**
 * 기존 서비스에서 새 서비스로 전환하는 순수 계획·검증 모듈(T065).
 * 실제 서비스 중지/시작, 독점 확인, 파일 복구는 호출자/운영 계층의 책임이다.
 */

export type CutoverSeverity = "pass" | "warn" | "block";
export type CutoverIssueCode =
    | "SOURCE_ID_MISSING"
    | "TARGET_ID_MISSING"
    | "SOURCE_NOT_RUNNING"
    | "SOURCE_NOT_STOPPED"
    | "EXCLUSIVE_NOT_CONFIRMED"
    | "TARGET_NOT_READY"
    | "TARGET_ALREADY_RUNNING"
    | "BACKUP_NOT_AVAILABLE"
    | "SOURCE_CHANGED"
    | "FRAME_COUNTER_INVALID"
    | "FRAME_COUNTER_ROLLBACK"
    | "FRAME_COUNTER_UNKNOWN"
    | "COUNTER_NOT_PRESERVED"
    | "SERVICE_COLLISION";

export interface CutoverIssue {
    severity: CutoverSeverity;
    code: CutoverIssueCode;
    detail: string;
}

/** plan: 원본 중지 전 계획 검증. execute: 원본 중지 후 시작 직전 검증. */
export type CutoverPhase = "plan" | "execute";

export interface CutoverInput {
    /** 생략하면 "plan". 계획 단계와 실행 단계의 조건이 서로 모순되지 않도록 분리한다. */
    phase?: CutoverPhase;
    sourceServiceId: string;
    targetServiceId: string;
    /** 전환 시작 직전 관찰값. 실제 stop/start는 수행하지 않는다. */
    sourceRunning: boolean;
    /** stop 실행 후 관찰값. 계획 단계에서는 생략할 수 있다. */
    sourceStopConfirmed?: boolean;
    exclusiveConfirmed: boolean;
    targetReady: boolean;
    targetRunning: boolean;
    backupAvailable: boolean;
    sourceUnchanged: boolean;
    sourceFrameCounter: number;
    /** target이 기록한 최신 counter. 확인할 수 없으면 undefined다. */
    targetFrameCounter?: number;
    /** 실패 복귀 시 counter를 안전하게 보존할 수 있는지 호출자가 확인한다. */
    counterPreserved: boolean;
}

export type CutoverAction =
    | "verify-backup"
    | "stop-source"
    | "confirm-source-stopped"
    | "confirm-exclusive"
    | "verify-frame-counter"
    | "start-target"
    | "verify-target"
    | "commit"
    | "stop-target-for-rollback"
    | "restore-source"
    | "verify-source-restored"
    | "verify-counter-preserved";

export interface CutoverPlan {
    canProceed: boolean;
    ready: boolean;
    issues: readonly CutoverIssue[];
    actions: readonly CutoverAction[];
    rollbackActions: readonly CutoverAction[];
    preserve: {
        sourceData: true;
        networkIdentity: true;
        frameCounter: true;
    };
    onFailure: "stop-target-then-restore-source";
}

/**
 * 수집된 상태만 판정해 안전한 전환 순서를 만든다.
 * 이 함수는 서비스를 중지하거나 시작하지 않는다.
 */
export function planCutover(input: CutoverInput): CutoverPlan {
    const issues = validateCutover(input);

    return {
        canProceed: !issues.some((issue) => issue.severity === "block"),
        ready: issues.length === 0,
        issues,
        actions: [
            "verify-backup",
            "stop-source",
            "confirm-source-stopped",
            "confirm-exclusive",
            "verify-frame-counter",
            "start-target",
            "verify-target",
            "commit",
        ],
        rollbackActions: ["stop-target-for-rollback", "restore-source", "verify-source-restored", "verify-counter-preserved"],
        preserve: {
            sourceData: true,
            networkIdentity: true,
            frameCounter: true,
        },
        onFailure: "stop-target-then-restore-source",
    };
}

/** 전환을 허용하기 전에 필요한 사전 조건을 순수하게 검사한다. */
export function validateCutover(input: CutoverInput): readonly CutoverIssue[] {
    const issues: CutoverIssue[] = [];
    const sourceId = input.sourceServiceId.trim();
    const targetId = input.targetServiceId.trim();

    if (!sourceId) issues.push({severity: "block", code: "SOURCE_ID_MISSING", detail: "원본 서비스 식별자가 필요합니다."});
    if (!targetId) issues.push({severity: "block", code: "TARGET_ID_MISSING", detail: "새 서비스 식별자가 필요합니다."});
    if (sourceId && targetId && sourceId === targetId) {
        issues.push({severity: "block", code: "SERVICE_COLLISION", detail: "원본과 새 서비스 식별자가 같습니다."});
    }
    if ((input.phase ?? "plan") === "plan") {
        // 계획 단계: stop-source 이전이므로 원본은 실행 중이어야 하고 중지/독점 확인은 아직 요구하지 않는다.
        if (!input.sourceRunning) issues.push({severity: "block", code: "SOURCE_NOT_RUNNING", detail: "전환 전 원본 서비스가 실행 중이어야 합니다."});
    } else {
        // 실행 단계: stop-source 이후이므로 원본은 중지되어야 하고 독점 점유가 확인되어야 한다.
        if (input.sourceRunning || input.sourceStopConfirmed !== true) {
            issues.push({severity: "block", code: "SOURCE_NOT_STOPPED", detail: "원본 서비스 중지가 확인되지 않았습니다."});
        }
        if (!input.exclusiveConfirmed)
            issues.push({severity: "block", code: "EXCLUSIVE_NOT_CONFIRMED", detail: "원본 중지 후 독점 점유를 확인해야 합니다."});
    }
    if (!input.targetReady)
        issues.push({severity: "block", code: "TARGET_NOT_READY", detail: "새 서비스의 시작 전 준비 상태가 확인되지 않았습니다."});
    if (input.targetRunning)
        issues.push({severity: "block", code: "TARGET_ALREADY_RUNNING", detail: "새 서비스가 이미 실행 중이므로 중복 점유 위험이 있습니다."});
    if (!input.backupAvailable) issues.push({severity: "block", code: "BACKUP_NOT_AVAILABLE", detail: "실패 복귀에 사용할 backup이 없습니다."});
    if (!input.sourceUnchanged)
        issues.push({severity: "block", code: "SOURCE_CHANGED", detail: "전환 중 원본 data가 변경되어 복귀 안전성을 확인할 수 없습니다."});

    if (!Number.isSafeInteger(input.sourceFrameCounter) || input.sourceFrameCounter < 0) {
        issues.push({severity: "block", code: "FRAME_COUNTER_INVALID", detail: "원본 frame counter는 0 이상의 안전한 정수여야 합니다."});
    }
    if (input.targetFrameCounter !== undefined && (!Number.isSafeInteger(input.targetFrameCounter) || input.targetFrameCounter < 0)) {
        issues.push({severity: "block", code: "FRAME_COUNTER_INVALID", detail: "새 서비스 frame counter는 0 이상의 안전한 정수여야 합니다."});
    } else if (input.targetFrameCounter === undefined) {
        // 신규 target은 시작 전 counter가 없으므로 계획 단계에서는 경고만 하고, 실행 단계에서 확인을 요구한다.
        issues.push({
            severity: (input.phase ?? "plan") === "plan" ? "warn" : "block",
            code: "FRAME_COUNTER_UNKNOWN",
            detail: "새 서비스 frame counter를 확인할 수 없습니다.",
        });
    } else if (input.targetFrameCounter < input.sourceFrameCounter) {
        issues.push({severity: "block", code: "FRAME_COUNTER_ROLLBACK", detail: "새 서비스 frame counter가 원본보다 작아 rollback 위험이 있습니다."});
    }
    if (!input.counterPreserved)
        issues.push({severity: "block", code: "COUNTER_NOT_PRESERVED", detail: "실패 복귀 시 frame counter 보존이 확인되지 않았습니다."});

    return issues;
}
