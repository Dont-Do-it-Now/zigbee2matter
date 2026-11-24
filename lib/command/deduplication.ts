import type {Command, CommandResult} from "./types";

const DEFAULT_MAX_ENTRIES = 10_000;

interface RecordEntry {
    fingerprint: string;
    idempotencyScope?: string;
    result?: CommandResult;
}

export interface CommandDeduplicatorOptions {
    /** Maximum number of completed request records retained for replay. */
    maxEntries?: number;
    /** Test seam for replayed result timestamps. */
    now?: () => number;
}

/** T014 admission hook: prevents duplicate RF while retaining completed command results. */
export default class CommandDeduplicator {
    private readonly records = new Map<string, RecordEntry>();
    private readonly idempotency = new Map<string, string>();
    private readonly completed: string[] = [];
    private readonly maxEntries: number;
    private readonly now: () => number;

    constructor(options: CommandDeduplicatorOptions = {}) {
        const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
        this.maxEntries = maxEntries;
        this.now = options.now ?? ((): number => Date.now());
    }

    /** Return a terminal replay/conflict result, or undefined to admit a new command. */
    admit = (command: Command): CommandResult | undefined => {
        const fingerprint = commandFingerprint(command);
        const request = this.records.get(command.requestId);

        if (request) {
            if (request.fingerprint !== fingerprint) {
                return conflict(command, "requestId is already used by another command", this.now());
            }

            return request.result ? {...request.result} : conflict(command, "request is already in flight", this.now());
        }

        const scope = idempotencyScope(command);
        const previousRequestId = scope === undefined ? undefined : this.idempotency.get(scope);
        const previous = previousRequestId === undefined ? undefined : this.records.get(previousRequestId);

        if (previous && previous.fingerprint !== fingerprint) {
            return conflict(command, "idempotency key is already used by another command", this.now());
        }

        if (previous) {
            return previous.result
                ? replay(command, previous.result, this.now())
                : conflict(command, "idempotency key is already in flight", this.now());
        }

        const entry: RecordEntry = {fingerprint, idempotencyScope: scope};
        this.records.set(command.requestId, entry);

        if (scope !== undefined) {
            this.idempotency.set(scope, command.requestId);
        }

        return undefined;
    };

    /** Store only terminal results; accepted does not make a command replayable. */
    onResult = (result: CommandResult): void => {
        if (!result.terminal) {
            return;
        }

        const entry = this.records.get(result.requestId);
        if (!entry) {
            return;
        }

        entry.result = {...result};
        this.completed.push(result.requestId);

        while (this.completed.length > this.maxEntries) {
            const requestId = this.completed.shift();
            if (requestId === undefined) {
                break;
            }

            const evicted = this.records.get(requestId);
            if (evicted?.result?.requestId === requestId) {
                this.records.delete(requestId);

                if (evicted.idempotencyScope !== undefined && this.idempotency.get(evicted.idempotencyScope) === requestId) {
                    this.idempotency.delete(evicted.idempotencyScope);
                }
            }
        }
    };
}

function idempotencyScope(command: Command): string | undefined {
    return command.idempotencyKey === undefined ? undefined : `${command.identity.principal}\u0000${command.idempotencyKey}`;
}

function commandFingerprint(command: Command): string {
    return JSON.stringify(canonical({
        source: command.source,
        identity: command.identity,
        target: command.target,
        operation: command.operation,
        value: command.value,
        idempotencyKey: command.idempotencyKey,
    }));
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }

    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    }

    return value;
}

function conflict(command: Command, message: string, at: number): CommandResult {
    return {
        requestId: command.requestId,
        correlationId: command.correlationId,
        status: "failed",
        terminal: true,
        errorCode: "CONFLICT",
        errorMessage: message,
        retryable: false,
        autoRetryAllowed: false,
        dispatched: false,
        at,
    };
}

function replay(command: Command, result: CommandResult, at: number): CommandResult {
    return {
        ...result,
        requestId: command.requestId,
        correlationId: command.correlationId,
        dispatched: false,
        at,
    };
}
