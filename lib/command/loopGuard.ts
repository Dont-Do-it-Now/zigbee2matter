import {createHash} from "node:crypto";

import type {Command} from "./types";

export interface LoopDiagnosis {
    correlationId: string;
    fingerprint: string;
    repeated: boolean;
    count: number;
    at: number;
}

export interface CommandLoopGuardOptions {
    windowMs?: number;
    maxEntries?: number;
    now?: () => number;
    onRepeat?: (diagnosis: LoopDiagnosis) => void;
}

interface SeenCommand {
    firstAt: number;
    lastAt: number;
    count: number;
}

/** T018 diagnostic guard. It reports repeated external commands but never blocks a valid command. */
export default class CommandLoopGuard {
    private readonly seen = new Map<string, SeenCommand>();
    private readonly windowMs: number;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly onRepeat?: (diagnosis: LoopDiagnosis) => void;

    constructor(options: CommandLoopGuardOptions = {}) {
        const windowMs = options.windowMs ?? 5_000;
        const maxEntries = options.maxEntries ?? 1_000;
        if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer");
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
        this.windowMs = windowMs;
        this.maxEntries = maxEntries;
        this.now = options.now ?? ((): number => Date.now());
        this.onRepeat = options.onRepeat;
    }

    record(command: Command): LoopDiagnosis {
        const at = this.now();
        if (!Number.isSafeInteger(at)) throw new Error("command loop clock is invalid");
        const fingerprint = fingerprintOf(command);
        const previous = this.seen.get(fingerprint);
        const repeated = previous !== undefined && at - previous.lastAt <= this.windowMs;
        const entry: SeenCommand = repeated
            ? {firstAt: previous.firstAt, lastAt: at, count: previous.count + 1}
            : {firstAt: at, lastAt: at, count: 1};

        this.seen.delete(fingerprint);
        this.seen.set(fingerprint, entry);

        while (this.seen.size > this.maxEntries) {
            const oldest = this.seen.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }

            this.seen.delete(oldest);
        }

        const diagnosis = {correlationId: command.correlationId, fingerprint, repeated, count: entry.count, at};
        if (repeated) {
            try {
                this.onRepeat?.(diagnosis);
            } catch {
                // Diagnostics must not affect command delivery.
            }
        }

        return diagnosis;
    }
}

function fingerprintOf(command: Command): string {
    const value = JSON.stringify({source: command.source, target: command.target, operation: command.operation, value: command.value});

    return createHash("sha256").update(value).digest("hex");
}
