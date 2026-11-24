/** T071 fault-injection plans. This module describes tests only; it performs no fault. */

export type FaultKind =
    | "coordinator"
    | "fabric"
    | "disk"
    | "crash"
    | "slow-ws"
    | "network"
    | "restart";

export type RecoveryExpectation =
    | "reconnect"
    | "resync"
    | "restore"
    | "safe-stop"
    | "restart-services";

export interface FaultPlan {
    readonly id: string;
    readonly kind: FaultKind;
    readonly injectionPoint: string;
    readonly trigger: string;
    readonly observations: readonly string[];
    readonly recovery: readonly RecoveryExpectation[];
    readonly safety: readonly string[];
    readonly destructive: boolean;
}

export interface FaultPlanReport {
    readonly valid: boolean;
    readonly errors: readonly string[];
}

const PLANS: readonly FaultPlan[] = [
    {
        id: "F01",
        kind: "coordinator",
        injectionPoint: "coordinator adapter connect/validate boundary",
        trigger: "연결 성공 직후 coordinator 연결을 끊는다",
        observations: ["recovery phase 전이", "RF 재초기화가 중복되지 않음", "명령은 unavailable 또는 안전하게 대기"],
        recovery: ["reconnect", "resync"],
        safety: ["coordinator identity와 network key를 변경하지 않음", "동시에 두 recovery loop를 실행하지 않음"],
        destructive: false,
    },
    {
        id: "F02",
        kind: "fabric",
        injectionPoint: "Matter fabric/session validation boundary",
        trigger: "fabric 검증 실패 또는 fabric store 접근 오류를 반환한다",
        observations: ["인증되지 않은 세션은 차단", "기존 fabric 데이터는 보존", "오류에 비밀값이 포함되지 않음"],
        recovery: ["safe-stop", "restart-services"],
        safety: ["ACL을 임의로 완화하지 않음", "fabric 삭제·재생성을 자동 수행하지 않음"],
        destructive: false,
    },
    {
        id: "F03",
        kind: "disk",
        injectionPoint: "T061 storage write/atomic replace boundary",
        trigger: "snapshot 저장 단계에서 공간 부족 또는 쓰기 오류를 반환한다",
        observations: ["원본 snapshot이 손상되지 않음", "부분 파일이 활성 백업으로 승격되지 않음", "오류와 복구 대상이 기록됨"],
        recovery: ["restore", "safe-stop"],
        safety: ["기존 백업을 삭제하지 않음", "passphrase·payload를 로그에 기록하지 않음"],
        destructive: true,
    },
    {
        id: "F04",
        kind: "crash",
        injectionPoint: "service lifecycle component boundary",
        trigger: "실행 중인 서비스가 예기치 않게 종료된 것으로 모델링한다",
        observations: ["stop 순서와 미완료 명령 상태가 관찰됨", "재시작 전 새 명령이 차단됨", "복구 후 snapshot/resync 경계가 명확함"],
        recovery: ["safe-stop", "restart-services", "resync"],
        safety: ["실제 프로세스를 종료하지 않음", "미확정 명령을 성공으로 승격하지 않음"],
        destructive: false,
    },
    {
        id: "F05",
        kind: "slow-ws",
        injectionPoint: "T017 platform consumer queue / T057 WS session",
        trigger: "WS consumer 전달을 bounded queue 한계까지 지연한다",
        observations: ["해당 consumer만 drop 또는 resync", "다른 consumer와 Core가 정체되지 않음", "epoch/sequence gap이 성공으로 숨겨지지 않음"],
        recovery: ["resync"],
        safety: ["queue를 무제한으로 늘리지 않음", "drop을 정상 연속성으로 판정하지 않음"],
        destructive: false,
    },
    {
        id: "F06",
        kind: "network",
        injectionPoint: "transport send/receive boundary",
        trigger: "송수신을 timeout 또는 단절로 응답한다",
        observations: ["timeout과 명령 결과를 구분", "멱등 명령만 deadline 안에서 재시도", "늦은 응답이 다른 request를 완료하지 않음"],
        recovery: ["reconnect", "resync"],
        safety: ["비멱등 명령을 자동 재전송하지 않음", "동일 device key의 순서를 보존"],
        destructive: false,
    },
    {
        id: "F07",
        kind: "restart",
        injectionPoint: "service lifecycle restart boundary",
        trigger: "정상 stop 뒤 동일 구성으로 다시 start한다",
        observations: ["역순 stop과 정순 start가 지켜짐", "identity/fabric/endpoint가 유지됨", "재시작 후 snapshot과 sequence 기준이 재설정됨"],
        recovery: ["restart-services", "restore", "resync"],
        safety: ["재시작 중 명령을 수락하지 않음", "저장 데이터의 atomic 경계를 우회하지 않음"],
        destructive: false,
    },
];

export function listFaultPlans(): readonly FaultPlan[] {
    return PLANS;
}

export function getFaultPlan(id: string): FaultPlan | undefined {
    return PLANS.find((plan) => plan.id === id);
}

export function validateFaultPlan(plan: FaultPlan): FaultPlanReport {
    const errors: string[] = [];
    if (plan.id.length === 0) errors.push("fault plan id is required");
    if (plan.injectionPoint.length === 0) errors.push("injection point is required");
    if (plan.trigger.length === 0) errors.push("trigger is required");
    if (plan.observations.length === 0) errors.push("at least one observation is required");
    if (plan.recovery.length === 0) errors.push("at least one recovery expectation is required");
    if (plan.safety.length === 0) errors.push("at least one safety constraint is required");
    if (plan.kind === "disk" && !plan.destructive) errors.push("disk fault must be marked destructive");
    if (plan.kind !== "disk" && plan.destructive) errors.push("only disk fault may be destructive");

    return {valid: errors.length === 0, errors};
}

export function validateAllFaultPlans(): FaultPlanReport {
    const errors = PLANS.flatMap((plan) => validateFaultPlan(plan).errors.map((error) => `${plan.id}: ${error}`));
    return {valid: errors.length === 0, errors};
}
