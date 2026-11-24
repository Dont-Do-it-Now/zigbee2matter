import type EventBus from "./eventBus";

export type RecoveryPhase = "connected" | "disconnected" | "recovering" | "stopped";

export interface RecoveryConnector {
    connect: (signal: AbortSignal) => Promise<void>;
    validateNetwork: () => Promise<void>;
}

export interface ConnectionRecoveryOptions {
    /** When supplied, adapter disconnect events are routed into this recovery loop. */
    eventBus?: EventBus;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
    onPhase?: (phase: RecoveryPhase, attempt: number) => void;
}

/** T025 exclusive reconnect coordinator. It never resets or reinitializes a coordinator. */
export default class ConnectionRecovery {
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly maxAttempts: number;
    private readonly onPhase?: (phase: RecoveryPhase, attempt: number) => void;
    private readonly eventBus?: EventBus;
    private generation = 0;
    private retryPromise: Promise<void> | undefined;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private retryResolve: (() => void) | undefined;
    private controller: AbortController | undefined;
    private currentPhase: RecoveryPhase = "connected";
    private attempt = 0;

    constructor(
        private readonly connector: RecoveryConnector,
        options: ConnectionRecoveryOptions = {},
    ) {
        this.eventBus = options.eventBus;
        this.baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? 250));
        this.maxDelayMs = Math.max(this.baseDelayMs, Math.floor(options.maxDelayMs ?? 10_000));
        this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 8));
        this.onPhase = options.onPhase;
        this.eventBus?.onAdapterDisconnected(this, async () => this.notifyDisconnected());
    }

    get phase(): RecoveryPhase {
        return this.currentPhase;
    }

    get attempts(): number {
        return this.attempt;
    }

    notifyDisconnected(): void {
        if (this.currentPhase === "stopped") {
            return;
        }

        this.setPhase("disconnected");
        if (!this.retryPromise) {
            const generation = ++this.generation;
            this.retryPromise = this.recover(generation).finally(() => {
                this.retryPromise = undefined;
            });
        }
    }

    async stop(): Promise<void> {
        this.eventBus?.removeListeners(this);
        this.setPhase("stopped");
        this.generation += 1;
        this.controller?.abort("STOPABORT");
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.retryResolve?.();
        this.retryResolve = undefined;

        await this.retryPromise;
    }

    private async recover(generation: number): Promise<void> {
        for (this.attempt = 1; this.attempt <= this.maxAttempts && generation === this.generation; this.attempt++) {
            this.setPhase("recovering");
            this.controller = new AbortController();

            try {
                await this.connector.connect(this.controller.signal);
                await this.connector.validateNetwork();
                this.setPhase("connected");
                this.attempt = 0;

                return;
            } catch {
                if (generation !== this.generation || this.currentPhase === "stopped") {
                    return;
                }

                this.setPhase("disconnected");
                if (this.attempt >= this.maxAttempts) {
                    return;
                }

                const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.attempt - 1));
                await this.wait(delay, generation);
            } finally {
                this.controller = undefined;
            }
        }
    }

    private wait(delayMs: number, generation: number): Promise<void> {
        return new Promise((resolve) => {
            this.retryResolve = resolve;
            this.retryTimer = setTimeout(() => {
                this.retryTimer = undefined;
                this.retryResolve = undefined;
                resolve();
            }, delayMs);

            if (generation !== this.generation) {
                clearTimeout(this.retryTimer);
                this.retryTimer = undefined;
                this.retryResolve = undefined;
                resolve();
            }
        });
    }

    private setPhase(phase: RecoveryPhase): void {
        this.currentPhase = phase;
        this.onPhase?.(phase, this.attempt);
    }
}
