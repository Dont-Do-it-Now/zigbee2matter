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
    private stopped = false;

    constructor(options: DeviceCommandQueueOptions = {}) {
        this.maxPending = options.maxPending ?? Infinity;
        this.maxConcurrent = options.maxConcurrent ?? Infinity;
        this.onRunError = options.onRunError;
        this.keyResolver =
            options.keyResolver ??
            ((command) => [command.operation === "request" ? `bridge:${command.target.request}` : command.target.entity]);
    }

    /** Hook-compatible scheduler. False means BUSY and guarantees that `run` was not called. */
    schedule = (command: Command, run: () => void): boolean => {
        if (this.stopped || this.pendingCount >= this.maxPending) {
            return false;
        }

        const keys = this.keys(command);
        if (keys.length === 0) {
            return false;
        }

        this.pendingCount += 1;
        const entry = {command, run};
        const blocked = keys.some((key) => this.queues.has(key) || this.hasRunningKey(key));

        if (blocked || this.running.size >= this.maxConcurrent) {
            for (const key of keys) {
                const queue = this.queues.get(key) ?? [];
                queue.push(entry);
                this.queues.set(key, queue);
            }
        } else {
            this.start(entry, keys);
        }

        return true;
    };

    /** Hook-compatible completion callback. Non-terminal results leave the entry running. */
    onResult = (result: CommandResult): void => {
        if (!result.terminal || !this.running.has(result.requestId)) {
            return;
        }

        const keys = this.running.get(result.requestId);
        this.running.delete(result.requestId);
        this.pendingCount = Math.max(0, this.pendingCount - 1);

        if (!this.stopped && keys) {
            this.pump();
        }
    };

    stop(): void {
        this.stopped = true;
        this.queues.clear();
    }

    private keys(command: Command): ReadonlyArray<string> {
        return [...new Set(this.keyResolver(command).filter((key) => key.length > 0))];
    }

    private hasRunningKey(key: string): boolean {
        return [...this.running.values()].some((keys) => keys.includes(key));
    }

    private start(entry: Entry, keys: ReadonlyArray<string>): void {
        this.running.set(entry.command.requestId, keys);
        try {
            entry.run();
        } catch (error) {
            // A runner is an adapter boundary. Its synchronous failure must not leave
            // the request in `running`, otherwise every command sharing its keys stalls.
            this.running.delete(entry.command.requestId);
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

    private pump(): void {
        if (this.running.size >= this.maxConcurrent) {
            return;
        }

        const candidates = new Set<Entry>();
        for (const queue of this.queues.values()) {
            const entry = queue[0];
            if (entry) {
                candidates.add(entry);
            }
        }

        for (const entry of candidates) {
            const keys = this.keys(entry.command);
            if (
                keys.some((key) => this.hasRunningKey(key)) ||
                keys.some((key) => this.queues.get(key)?.[0] !== entry) ||
                this.running.size >= this.maxConcurrent
            ) {
                continue;
            }

            this.removeQueued(entry, keys);
            this.start(entry, keys);
            return;
        }
    }

    private removeQueued(entry: Entry, keys: ReadonlyArray<string>): void {
        for (const key of keys) {
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
