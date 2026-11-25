export type OtaJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface OtaJob {
    readonly id: string;
    readonly deviceIeeeAddr: string;
    readonly createdAt: number;
    status: OtaJobStatus;
    progress?: number;
    remaining?: number;
    error?: string;
    cancelRequested: boolean;
    startedAt?: number;
    finishedAt?: number;
}

export interface OtaJobStoreOptions {
    maxConcurrent?: number;
    now?: () => number;
    idFactory?: () => string;
}

export class OtaJobStore {
    readonly #jobs = new Map<string, OtaJob>();
    readonly #maxConcurrent: number;
    readonly #now: () => number;
    readonly #idFactory: () => string;

    constructor(options: OtaJobStoreOptions = {}) {
        this.#maxConcurrent = options.maxConcurrent ?? 1;
        this.#now = options.now ?? Date.now;
        this.#idFactory = options.idFactory ?? (() => `ota-${this.#timestamp()}-${Math.random().toString(36).slice(2, 8)}`);
        if (!Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer");
    }

    get activeCount(): number {
        return [...this.#jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    }

    get maxConcurrent(): number {
        return this.#maxConcurrent;
    }

    create(deviceIeeeAddr: string): OtaJob {
        if (this.activeCount >= this.#maxConcurrent) throw new Error("OTA concurrency limit reached");
        if ([...this.#jobs.values()].some((job) => job.deviceIeeeAddr === deviceIeeeAddr && (job.status === "queued" || job.status === "running"))) {
            throw new Error("OTA job already active for device");
        }

        const id = this.#idFactory();
        if (typeof id !== "string" || id.length === 0 || this.#jobs.has(id)) throw new Error("OTA job id is invalid or already exists");

        const job: OtaJob = {
            id,
            deviceIeeeAddr,
            createdAt: this.#timestamp(),
            status: "queued",
            cancelRequested: false,
        };
        this.#jobs.set(job.id, job);
        return job;
    }

    get(id: string): OtaJob | undefined {
        return this.#jobs.get(id);
    }

    list(): readonly OtaJob[] {
        return [...this.#jobs.values()].map((job) => ({...job}));
    }

    findActiveByDevice(deviceIeeeAddr: string): OtaJob | undefined {
        return [...this.#jobs.values()].find((job) => job.deviceIeeeAddr === deviceIeeeAddr && (job.status === "queued" || job.status === "running"));
    }

    start(job: OtaJob): void {
        try {
            this.#assertMutable(job);
        } catch (error) {
            // 시작 전 취소 요청 등으로 실패하면 queued로 남아 전체 OTA를 막지 않도록 종료 처리한다.
            this.fail(job, error);
            throw error;
        }
        job.status = "running";
        job.startedAt = this.#timestamp();
    }

    progress(job: OtaJob, progress: number, remaining?: number): void {
        try {
            this.#assertMutable(job);
        } catch (error) {
            this.fail(job, error);
            throw error;
        }
        if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error("OTA progress must be between 0 and 100");
        job.progress = progress;
        if (remaining !== undefined) {
            if (!Number.isFinite(remaining) || remaining < 0) throw new Error("OTA remaining must be non-negative");
            job.remaining = Math.round(remaining);
        }
    }

    requestCancel(job: OtaJob): boolean {
        if (job.status !== "queued" && job.status !== "running") return false;
        job.cancelRequested = true;
        return true;
    }

    cancel(job: OtaJob): void {
        if (job.status === "completed" || job.status === "failed" || job.status === "interrupted") return;
        job.cancelRequested = true;
        job.status = "cancelled";
        job.finishedAt = this.#timestamp();
    }

    complete(job: OtaJob): void {
        if (job.cancelRequested) {
            this.cancel(job);
            return;
        }
        this.#assertMutable(job);
        job.progress = 100;
        job.status = "completed";
        job.finishedAt = this.#timestamp();
    }

    fail(job: OtaJob, error: unknown): void {
        if (job.status === "completed" || job.status === "failed" || job.status === "interrupted") return;
        if (job.cancelRequested) {
            this.cancel(job);
            return;
        }
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = this.#timestamp();
    }

    interruptActive(): void {
        for (const job of this.#jobs.values()) {
            if (job.status === "queued" || job.status === "running") {
                job.status = "interrupted";
                job.error = "service restarted before OTA completion";
                job.finishedAt = this.#timestamp();
            }
        }
    }

    #assertMutable(job: OtaJob): void {
        if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") {
            throw new Error(`OTA job '${job.id}' is already terminal`);
        }
        if (job.cancelRequested) throw new Error(`OTA job '${job.id}' cancellation requested`);
    }

    #timestamp(): number {
        const value = this.#now();
        if (!Number.isSafeInteger(value)) throw new Error("OTA clock is invalid");

        return value;
    }
}
