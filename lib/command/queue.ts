import type {Command, CommandResult} from "./types";

export interface DeviceCommandQueueOptions {
    /** Maximum queued or running commands. `Infinity` disables the global limit. */
    maxPending?: number;
    /** Maximum number of different target keys that may run at once. */
    maxConcurrent?: number;
    /** Returns all device keys affected by a command. The default uses the target entity. */
    keyResolver?: (command: Command) => ReadonlyArray<string>;
    /** Called when a scheduled runner throws synchronously. The queue still advances. */
    onRunError?: (command: Command, error: unknown) => void;
}

interface Entry {
    command: Command;
    keys: ReadonlyArray<string>;
    run: () => void;
}

/**
 * Scheduler for T013. Commands sharing any key are FIFO-serialized; commands with
 * disjoint keys may run in parallel up to `maxConcurrent`.
 */
export default class DeviceCommandQueue {
    private readonly queues = new Map<string, Entry[]>();
    private readonly running = new Map<string, ReadonlyArray<string>>();
    private readonly keyResolver: (command: Command) => ReadonlyArray<string>;
    private readonly maxPending: number;
    private readonly maxConcurrent: number;
    private readonly onRunError?: DeviceCommandQueueOptions["onRunError"];
    private pendingCount = 0;
    private readonly pendingIds = new Set<string>();
    private stopped = false;
    private pumping = false;

    constructor(options: DeviceCommandQueueOptions = {}) {
        this.maxPending = validateLimit(options.maxPending ?? Number.POSITIVE_INFINITY, "maxPending");
        this.maxConcurrent = validateLimit(options.maxConcurrent ?? Number.POSITIVE_INFINITY, "maxConcurrent");
        this.onRunError = options.onRunError;
        this.keyResolver = options.keyResolver ?? defaultKeys;
    }

    start(): void {
        this.stopped = false;
    }

    /** Hook-compatible scheduler. False means BUSY and guarantees that `run` was not called. */
    schedule = (command: Command, run: () => void): boolean => {
        if (this.stopped || this.pendingCount >= this.maxPending) {
            return false;
        }

        const keys = this.keys(command);
        if (keys.length === 0 || this.pendingIds.has(command.requestId)) {
            return false;
        }

        this.pendingCount += 1;
        this.pendingIds.add(command.requestId);
        const entry: Entry = {command, keys, run};
        const blocked = keys.some((key) => this.queues.has(key) || this.hasRunningKey(key));

        if (blocked || this.running.size >= this.maxConcurrent) {
            for (const key of keys) {
                const queue = this.queues.get(key) ?? [];
                queue.push(entry);
                this.queues.set(key, queue);
            }
        } else {
            this.runEntry(entry, keys);
        }

        return true;
    };

    /** Hook-compatible completion callback. Non-terminal results leave the entry running. */
    onResult = (result: CommandResult): void => {
        // CONFLICT is emitted by the router for a duplicate of an in-flight requestId; it must not end the original entry.
        if (!result.terminal || result.errorCode === "CONFLICT" || !this.pendingIds.has(result.requestId)) {
            return;
        }

        // Every terminal path releases the entry. A queued command that ended (deadline, stop) must also leave the
        // queues, otherwise pump() would start a dead entry and leave it in `running` forever.
        this.pendingIds.delete(result.requestId);
        this.running.delete(result.requestId);
        this.dropQueued(result.requestId);
        this.pendingCount = Math.max(0, this.pendingCount - 1);

        if (!this.stopped) {
            this.pump();
        }
    };

    /** Releases a dispatched command's device key while its result observation remains pending. */
    onDispatched = (requestId: string): void => {
        if (!this.pendingIds.has(requestId) || !this.running.has(requestId)) return;

        this.running.delete(requestId);
        if (!this.stopped) this.pump();
    };

    stop(): void {
        this.stopped = true;
        this.queues.clear();
        this.pendingIds.clear();
        this.running.clear();
        this.pendingCount = 0;
    }

    private keys(command: Command): ReadonlyArray<string> {
        return [...new Set(this.keyResolver(command).filter((key) => key.length > 0))];
    }

    private hasRunningKey(key: string): boolean {
        return [...this.running.values()].some((keys) => keys.includes(key));
    }

    private runEntry(entry: Entry, keys: ReadonlyArray<string>): void {
        this.running.set(entry.command.requestId, keys);
        try {
            entry.run();
        } catch (error) {
            // A runner is an adapter boundary. Its synchronous failure must not leave
            // the request in `running`, otherwise every command sharing its keys stalls.
            this.running.delete(entry.command.requestId);
            this.pendingIds.delete(entry.command.requestId);
            this.pendingCount = Math.max(0, this.pendingCount - 1);
            try {
                this.onRunError?.(entry.command, error);
            } catch {
                // Error reporting must not prevent the scheduler from advancing.
            }
            if (!this.stopped) {
                this.pump();
            }
        }
    }

    /** Starts every runnable head entry. Re-entrant calls (synchronous terminal results) are absorbed by the running loop. */
    private pump(): void {
        if (this.pumping) {
            return;
        }

        this.pumping = true;
        try {
            for (let entry = this.nextRunnable(); entry && !this.stopped; entry = this.nextRunnable()) {
                this.removeQueued(entry);
                this.runEntry(entry, entry.keys);
            }
        } finally {
            this.pumping = false;
        }
    }

    private nextRunnable(): Entry | undefined {
        if (this.running.size >= this.maxConcurrent) {
            return undefined;
        }

        for (const queue of this.queues.values()) {
            const entry = queue[0];
            if (!entry) {
                continue;
            }

            if (!this.pendingIds.has(entry.command.requestId)) {
                // Defensive: a finished command must never be started.
                this.removeQueued(entry);
                return this.nextRunnable();
            }

            const {keys} = entry;
            if (!keys.some((key) => this.hasRunningKey(key)) && keys.every((key) => this.queues.get(key)?.[0] === entry)) {
                return entry;
            }
        }

        return undefined;
    }

    private dropQueued(requestId: string): void {
        for (const queue of [...this.queues.values()]) {
            const entry = queue.find((candidate) => candidate.command.requestId === requestId);
            if (entry) {
                this.removeQueued(entry);
                return;
            }
        }
    }

    private removeQueued(entry: Entry): void {
        for (const key of entry.keys) {
            const queue = this.queues.get(key);
            if (!queue) {
                continue;
            }

            const remaining = queue.filter((candidate) => candidate !== entry);
            if (remaining.length === 0) {
                this.queues.delete(key);
            } else {
                this.queues.set(key, remaining);
            }
        }
    }
}

function defaultKeys(command: Command): ReadonlyArray<string> {
    if (command.operation === "request") {
        return [`bridge:${command.target.request}`];
    }

    return [command.target.key ?? command.target.entity ?? ""];
}

function validateLimit(value: number, name: string): number {
    if (value !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`${name} must be a positive integer or Infinity`);
    }

    return value;
}
