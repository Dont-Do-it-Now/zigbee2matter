export type AvailabilityStatus = "online" | "offline" | "unknown";
export type AvailabilityScope = "coordinator" | "device" | "group";

export interface AvailabilityDecision {
    status: AvailabilityStatus;
    reachable?: boolean;
    scope: AvailabilityScope;
    shouldProbe: boolean;
    reason: "recent-report" | "timeout" | "sleepy-timeout" | "explicit-leave" | "member-online" | "no-member-evidence";
}

export interface AvailabilityInput {
    scope: AvailabilityScope;
    lastSeen?: number;
    timeoutMs?: number;
    sleepy?: boolean;
    explicitLeave?: boolean;
    memberStates?: ReadonlyArray<AvailabilityStatus>;
}

/** T029 maps upstream availability signals without replacing the existing ping policy. */
export function evaluateAvailability(input: AvailabilityInput, now = Date.now()): AvailabilityDecision {
    if (input.scope === "coordinator") {
        if (input.explicitLeave) {
            return {status: "offline", reachable: false, scope: input.scope, shouldProbe: false, reason: "explicit-leave"};
        }

        const recent = input.lastSeen !== undefined && input.timeoutMs !== undefined && now - input.lastSeen < input.timeoutMs;
        if (recent) {
            return {status: "online", reachable: true, scope: input.scope, shouldProbe: false, reason: "recent-report"};
        }

        return {status: "unknown", scope: input.scope, shouldProbe: true, reason: "timeout"};
    }

    if (input.scope === "group") {
        const members = input.memberStates ?? [];
        if (members.includes("online")) {
            return {status: "online", reachable: true, scope: input.scope, shouldProbe: false, reason: "member-online"};
        }

        if (members.length > 0 && members.every((status) => status === "offline")) {
            return {status: "offline", reachable: false, scope: input.scope, shouldProbe: false, reason: "timeout"};
        }

        return {status: "unknown", scope: input.scope, shouldProbe: false, reason: "no-member-evidence"};
    }

    if (input.explicitLeave) {
        return {status: "offline", reachable: false, scope: input.scope, shouldProbe: false, reason: "explicit-leave"};
    }

    const recent = input.lastSeen !== undefined && input.timeoutMs !== undefined && now - input.lastSeen < input.timeoutMs;
    if (recent) {
        return {status: "online", reachable: true, scope: input.scope, shouldProbe: false, reason: "recent-report"};
    }

    if (input.sleepy) {
        return {status: "unknown", scope: input.scope, shouldProbe: false, reason: "sleepy-timeout"};
    }

    return {status: "offline", reachable: false, scope: input.scope, shouldProbe: true, reason: "timeout"};
}
