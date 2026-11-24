export type InterviewState = "unknown" | "joined" | "started" | "successful" | "failed" | "left";

export interface PairingDeviceState {
    ieeeAddr: string;
    interview: InterviewState;
    updatedAt: number;
}

export interface PairingPolicyOptions {
    now?: () => number;
}

/** T027 pairing/interview policy. Upstream remains the owner of interview/configure operations. */
export default class PairingPolicy {
    private readonly devices = new Map<string, PairingDeviceState>();
    private readonly now: () => number;
    private permitJoinEnd?: number;

    constructor(options: PairingPolicyOptions = {}) {
        this.now = options.now ?? ((): number => Date.now());
    }

    setPermitJoinEnd(endAt: number | undefined): void {
        if (endAt !== undefined && (!Number.isSafeInteger(endAt) || endAt < 0)) {
            throw new Error("permit join end must be a non-negative epoch millisecond");
        }

        this.permitJoinEnd = endAt;
    }

    isPermitJoinActive(at = this.now()): boolean {
        return this.permitJoinEnd !== undefined && this.permitJoinEnd > at;
    }

    recordJoined(ieeeAddr: string, at = this.now()): PairingDeviceState {
        return this.record(ieeeAddr, "joined", at);
    }

    recordInterview(ieeeAddr: string, status: Exclude<InterviewState, "unknown" | "joined" | "left">, at = this.now()): PairingDeviceState {
        return this.record(ieeeAddr, status, at);
    }

    recordLeft(ieeeAddr: string, at = this.now()): PairingDeviceState {
        return this.record(ieeeAddr, "left", at);
    }

    get(ieeeAddr: string): PairingDeviceState | undefined {
        const state = this.devices.get(normalizeIeee(ieeeAddr));

        return state === undefined ? undefined : {...state};
    }

    /** Matter exposure is withheld until the latest interview succeeds. */
    canExposeToMatter(ieeeAddr: string): boolean {
        return this.devices.get(normalizeIeee(ieeeAddr))?.interview === "successful";
    }

    private record(ieeeAddr: string, interview: InterviewState, at: number): PairingDeviceState {
        const normalized = normalizeIeee(ieeeAddr);
        if (normalized.length === 0) {
            throw new Error("IEEE address is required");
        }

        const state = {ieeeAddr: normalized, interview, updatedAt: at};
        this.devices.set(normalized, state);

        return {...state};
    }
}

function normalizeIeee(value: string): string {
    return value.trim().toLowerCase();
}
