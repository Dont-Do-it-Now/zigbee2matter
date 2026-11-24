import {createHash} from "node:crypto";

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
        return {allowed: true, reason: "same-coordinator", reuseIdentity: true, requiresRejoin: false};
    }

    if (!approved) {
        return {allowed: false, reason: "approval-required", reuseIdentity: false, requiresRejoin: true};
    }

    if (stored.extendedPanId !== undefined && live.extendedPanId !== undefined && !sameValue(stored.extendedPanId, live.extendedPanId)) {
        return {allowed: false, reason: "network-mismatch", reuseIdentity: false, requiresRejoin: true};
    }

    if (
        stored.networkKeyFingerprint !== undefined &&
        live.networkKeyFingerprint !== undefined &&
        stored.networkKeyFingerprint !== live.networkKeyFingerprint
    ) {
        return {allowed: false, reason: "network-key-mismatch", reuseIdentity: false, requiresRejoin: true};
    }

    if (stored.frameCounter !== undefined && live.frameCounter !== undefined && live.frameCounter < stored.frameCounter) {
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
