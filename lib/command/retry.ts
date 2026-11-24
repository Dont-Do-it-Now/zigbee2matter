import {isIdempotent} from "./mapping";
import type {Command, CommandResult} from "./types";

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;

export interface RetryPolicyOptions {
    /** Total dispatch attempts, including the first attempt. */
    maxAttempts?: number;
    /** Initial exponential backoff. */
    baseDelayMs?: number;
    /** Upper bound for one backoff delay. */
    maxDelayMs?: number;
}

export interface RetryDecision {
    retry: boolean;
    delayMs: number;
    reason: "allowed" | "not-retryable" | "non-idempotent" | "attempt-limit" | "deadline";
}

/**
 * T015 policy only. It never dispatches a command; the caller owns resubmission and must create a new requestId.
 */
export class CommandRetryPolicy {
    private readonly maxAttempts: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;

    constructor(options: RetryPolicyOptions = {}) {
        this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
        this.baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
        this.maxDelayMs = Math.max(this.baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
    }

    decide(command: Command, result: CommandResult, attempts: number, now = Date.now()): RetryDecision {
        if (!result.retryable) {
            return {retry: false, delayMs: 0, reason: "not-retryable"};
        }

        if (!result.autoRetryAllowed || !isIdempotent(command)) {
            return {retry: false, delayMs: 0, reason: "non-idempotent"};
        }

        if (attempts >= this.maxAttempts) {
            return {retry: false, delayMs: 0, reason: "attempt-limit"};
        }

        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1));
        const remaining = command.deadline - now;
        const delayMs = Math.min(exponential, Math.max(0, remaining - 1));

        if (delayMs <= 0) {
            return {retry: false, delayMs: 0, reason: "deadline"};
        }

        return {retry: true, delayMs, reason: "allowed"};
    }
}

export default CommandRetryPolicy;
