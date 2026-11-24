/** API 인증 실패의 IP별 sliding-window 제한(T058). */

export interface RateLimitOptions {
    readonly maxFailures?: number;
    readonly windowMs?: number;
    readonly now?: () => number;
}

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
        this.maxFailures = Math.max(1, Math.floor(options.maxFailures ?? 10));
        this.windowMs = Math.max(1, Math.floor(options.windowMs ?? 60_000));
        this.now = options.now ?? Date.now;
    }

    allow(key: string): boolean {
        const window = this.current(key);
        return window === undefined || window.failures < this.maxFailures;
    }

    recordFailure(key: string): boolean {
        const now = this.now();
        const window = this.current(key) ?? {startedAt: now, failures: 0};
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
        if (this.now() - window.startedAt >= this.windowMs) {
            this.windows.delete(key);
            return undefined;
        }
        return window;
    }
}
