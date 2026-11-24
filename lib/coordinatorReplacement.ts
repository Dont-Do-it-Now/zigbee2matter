import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";

export interface CoordinatorIdentity {
    ieeeAddr: string;
    extendedPanId?: string;
    /** Pre-hashed network key fingerprint; raw keys must not enter this policy. */
    networkKeyFingerprint?: string;
    frameCounter?: number;
}

export interface CoordinatorReplacementRequest {
    stored: CoordinatorIdentity;
    live: CoordinatorIdentity;
    approved: boolean;
}

export type ReplacementReason =
    | "same-coordinator"
    | "approval-required"
    | "network-mismatch"
    | "network-key-mismatch"
    | "frame-counter-rollback"
    | "verification-required"
    | "approved-replacement";

export interface CoordinatorReplacementDecision {
    allowed: boolean;
    reason: ReplacementReason;
    reuseIdentity: boolean;
    requiresRejoin: boolean;
}

/** T026 pure replacement gate. It never changes settings, keys, or coordinator state. */
export function evaluateCoordinatorReplacement(request: CoordinatorReplacementRequest): CoordinatorReplacementDecision {
    const {stored, live, approved} = request;
    const sameIeee = normalizeIeee(stored.ieeeAddr) === normalizeIeee(live.ieeeAddr);

    if (sameIeee) {
        // 같은 IEEE라도 확인 가능한 값이 어긋나면 허용하지 않는다(값이 없으면 기존 동작 유지).
        if (stored.extendedPanId && live.extendedPanId && !sameValue(stored.extendedPanId, live.extendedPanId)) {
            return {allowed: false, reason: "network-mismatch", reuseIdentity: false, requiresRejoin: true};
        }

        if (isValidFrameCounter(stored.frameCounter) && isValidFrameCounter(live.frameCounter) && live.frameCounter < stored.frameCounter) {
            return {allowed: false, reason: "frame-counter-rollback", reuseIdentity: false, requiresRejoin: true};
        }

        return {allowed: true, reason: "same-coordinator", reuseIdentity: true, requiresRejoin: false};
    }

    if (!approved) {
        return {allowed: false, reason: "approval-required", reuseIdentity: false, requiresRejoin: true};
    }

    if (
        !stored.extendedPanId ||
        !live.extendedPanId ||
        !stored.networkKeyFingerprint ||
        !live.networkKeyFingerprint ||
        !isValidFrameCounter(stored.frameCounter) ||
        !isValidFrameCounter(live.frameCounter)
    ) {
        return {allowed: false, reason: "verification-required", reuseIdentity: false, requiresRejoin: true};
    }

    if (!sameValue(stored.extendedPanId, live.extendedPanId)) {
        return {allowed: false, reason: "network-mismatch", reuseIdentity: false, requiresRejoin: true};
    }

    if (stored.networkKeyFingerprint !== live.networkKeyFingerprint) {
        return {allowed: false, reason: "network-key-mismatch", reuseIdentity: false, requiresRejoin: true};
    }

    if (live.frameCounter < stored.frameCounter) {
        return {allowed: false, reason: "frame-counter-rollback", reuseIdentity: false, requiresRejoin: true};
    }

    return {allowed: true, reason: "approved-replacement", reuseIdentity: true, requiresRejoin: false};
}

/** Diagnostic-only fingerprint helper for callers that have a raw key; the raw value is never returned. */
export function networkKeyFingerprint(rawKey: string): string {
    return createHash("sha256").update(rawKey).digest("hex");
}

function normalizeIeee(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, "");
}

function sameValue(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isValidFrameCounter(value: number | undefined): value is number {
    return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** herdsman `coordinator_backup.json`(Unified backup)에서 비교용 identity를 만든다. raw key는 fingerprint로만 남긴다. */
export function identityFromBackup(backup: unknown): CoordinatorIdentity | undefined {
    if (typeof backup !== "object" || backup === null) return undefined;

    const b = backup as {coordinator_ieee?: unknown; extended_pan_id?: unknown; network_key?: {key?: unknown; frame_counter?: unknown}};

    if (typeof b.coordinator_ieee !== "string") return undefined;

    const key = b.network_key?.key;
    const counter = b.network_key?.frame_counter;

    return {
        ieeeAddr: b.coordinator_ieee,
        extendedPanId: typeof b.extended_pan_id === "string" ? b.extended_pan_id : undefined,
        networkKeyFingerprint: typeof key === "string" || Array.isArray(key) ? networkKeyFingerprint(String(key)) : undefined,
        frameCounter: typeof counter === "number" ? counter : undefined,
    };
}

/** 허용되지 않은 교체는 예외로 차단한다(조용한 성공 금지). */
export function assertCoordinatorReplacement(request: CoordinatorReplacementRequest): CoordinatorReplacementDecision {
    const decision = evaluateCoordinatorReplacement(request);

    if (!decision.allowed) {
        throw new Error(
            `coordinator replacement blocked: ${decision.reason}${decision.requiresRejoin ? " (device re-pairing may be required)" : ""}`,
        );
    }

    return decision;
}

/** 시작 전 coordinator_backup.json에서 기존 identity를 읽는다. 없거나 깨졌으면 undefined(검증 생략). */
export function readBackupIdentity(backupPath: string): CoordinatorIdentity | undefined {
    try {
        return identityFromBackup(JSON.parse(readFileSync(backupPath, "utf8")));
    } catch {
        return undefined;
    }
}

const HARD_MISMATCH: readonly ReplacementReason[] = ["network-mismatch", "network-key-mismatch", "frame-counter-rollback"];

/**
 * 시작 후 advisory 검사. upstream의 자동 복원(restored)은 정상이므로 Zigbee는 막지 않는다.
 * 확인된 불일치(extendedPanId·키 fingerprint·frame counter rollback)일 때만 차단 사유 문자열을 반환한다(Matter 노출 차단용).
 * approval-required/verification-required는 경고만 하고 undefined를 반환한다. approved=true면 검사하지 않는다.
 */
export function checkStartupReplacement(
    stored: CoordinatorIdentity | undefined,
    live: CoordinatorIdentity,
    approved: boolean,
    log: {warning: (m: string) => void; error: (m: string) => void},
): string | undefined {
    if (stored === undefined || approved) return undefined;

    // 승인 여부와 무관하게 확인 가능한 불일치만 본다.
    const decision = evaluateCoordinatorReplacement({stored, live, approved: true});

    if (HARD_MISMATCH.includes(decision.reason)) {
        const reason = `coordinator replacement unverified: ${decision.reason}`;
        log.error(
            `${reason}. Matter exposure is blocked; Zigbee keeps running. ` +
                "Verify the coordinator and set 'advanced.coordinator_replacement_approved: true' to allow.",
        );
        return reason;
    }

    if (decision.reason === "verification-required" || (!decision.allowed && decision.reason !== "same-coordinator")) {
        log.warning(`Coordinator changed (${decision.reason}); could not fully verify network continuity (device re-pairing may be required).`);
    } else if (decision.reason === "approved-replacement") {
        log.warning("Coordinator was replaced; network parameters match the previous backup.");
    }

    return undefined;
}
