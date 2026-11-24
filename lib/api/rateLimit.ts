/** API 인증 실패의 IP별 sliding-window 제한(T058). */

export interface RateLimitOptions {
    readonly maxFailures?: number;
    readonly windowMs?: number;
    readonly now?: () => number;
}

const MAX_TRACKED_KEYS = 10_000;

interface FailureWindow {
    startedAt: number;
    failures: number;
}

export class AuthFailureRateLimiter {
    private readonly maxFailures: number;
    private readonly windowMs: number;
    private readonly now: () => number;
    private readonly windows = new Map<string, FailureWindow>();

    constructor(options: RateLimitOptions = {}) {
        const maxFailures = options.maxFailures ?? 10;
        const windowMs = options.windowMs ?? 60_000;
        if (!Number.isSafeInteger(maxFailures) || maxFailures < 1) throw new Error("maxFailures must be a positive integer");
        if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer");
        this.maxFailures = maxFailures;
        this.windowMs = windowMs;
        this.now = options.now ?? Date.now;
    }

    allow(key: string): boolean {
        const window = this.current(key);
        return window === undefined || window.failures < this.maxFailures;
    }

    recordFailure(key: string): boolean {
        const now = this.now();
        if (!Number.isSafeInteger(now)) throw new Error("rate-limit clock is invalid");
        const window = this.current(key) ?? {startedAt: now, failures: 0};
        if (!this.windows.has(key) && this.windows.size >= MAX_TRACKED_KEYS) {
            this.clearExpired();
            if (this.windows.size >= MAX_TRACKED_KEYS) this.windows.delete(this.windows.keys().next().value as string);
        }
        window.failures += 1;
        this.windows.set(key, window);
        return window.failures <= this.maxFailures;
    }

    reset(key: string): void {
        this.windows.delete(key);
    }

    clearExpired(): void {
        for (const key of this.windows.keys()) {
            if (this.current(key) === undefined) this.windows.delete(key);
        }
    }

    private current(key: string): FailureWindow | undefined {
        const window = this.windows.get(key);
        if (!window) return undefined;
        const now = this.now();
        if (!Number.isSafeInteger(now)) throw new Error("rate-limit clock is invalid");
        if (now - window.startedAt >= this.windowMs) {
            this.windows.delete(key);
            return undefined;
        }
        return window;
    }
}
