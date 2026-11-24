import {describe, expect, it} from "vitest";

import {OtaJobStore} from "../../../lib/ota/job";

function store(options: ConstructorParameters<typeof OtaJobStore>[0] = {}) {
    let now = 1_000;
    let seq = 0;

    return {
        jobs: new OtaJobStore({now: () => now++, idFactory: () => `job-${++seq}`, ...options}),
    };
}

describe("OtaJobStore", () => {
    it("creates queued jobs, limits concurrency and rejects a second active job for the same device", () => {
        const {jobs} = store({maxConcurrent: 2});
        const a = jobs.create("0x01");

        expect(a).toMatchObject({id: "job-1", status: "queued", cancelRequested: false});
        expect(() => jobs.create("0x01")).toThrow("already active");
        jobs.create("0x02");
        expect(() => jobs.create("0x03")).toThrow("concurrency limit");
        expect(jobs.activeCount).toBe(2);
        expect(jobs.findActiveByDevice("0x02")?.id).toBe("job-2");
    });

    it("validates constructor and id factory", () => {
        expect(() => new OtaJobStore({maxConcurrent: 0})).toThrow();
        expect(() => new OtaJobStore({maxConcurrent: 1.5})).toThrow();
        expect(() => new OtaJobStore({idFactory: () => ""}).create("0x01")).toThrow("invalid");
        expect(() => new OtaJobStore({now: () => Number.NaN}).create("0x01")).toThrow("clock");
        const dup = new OtaJobStore({maxConcurrent: 2, idFactory: () => "same"});
        dup.create("0x01");
        expect(() => dup.create("0x02")).toThrow("already exists");
    });

    it("start moves queued to running and records startedAt", () => {
        const {jobs} = store();
        const job = jobs.create("0x01");
        jobs.start(job);

        expect(job.status).toBe("running");
        expect(job.startedAt).toEqual(expect.any(Number));
    });

    it("a start that fails never leaves the job queued (a cancel requested before start ends it as cancelled)", () => {
        const {jobs} = store();
        const job = jobs.create("0x01");
        expect(jobs.requestCancel(job)).toBe(true);

        expect(() => jobs.start(job)).toThrow("cancellation requested");
        expect(job.status).toBe("cancelled");
        expect(job.finishedAt).toEqual(expect.any(Number));
        expect(jobs.activeCount).toBe(0);
        expect(jobs.findActiveByDevice("0x01")).toBeUndefined();
        expect(jobs.create("0x01").status).toBe("queued"); // the device and the slot are free again
    });

    it("starting an already terminal job throws and keeps its terminal status", () => {
        const {jobs} = store();
        const job = jobs.create("0x01");
        jobs.fail(job, new Error("boom"));

        expect(() => jobs.start(job)).toThrow("already terminal");
        expect(job).toMatchObject({status: "failed", error: "boom"});
        expect(jobs.activeCount).toBe(0);
    });

    it("progress validates range, updates remaining, and a cancel request fails the job out of the active set", () => {
        const {jobs} = store();
        const job = jobs.create("0x01");
        jobs.start(job);
        jobs.progress(job, 40, 12.6);
        expect(job).toMatchObject({progress: 40, remaining: 13});
        expect(() => jobs.progress(job, 101)).toThrow("between 0 and 100");
        expect(() => jobs.progress(job, Number.NaN)).toThrow();
        expect(() => jobs.progress(job, 50, -1)).toThrow("non-negative");

        jobs.requestCancel(job);
        expect(() => jobs.progress(job, 60)).toThrow("cancellation requested");
        expect(job.status).toBe("cancelled");
        expect(jobs.activeCount).toBe(0);
    });

    it("complete sets 100 and completed; a pending cancel turns completion into cancelled; terminal states are sticky", () => {
        const {jobs} = store({maxConcurrent: 3});
        const done = jobs.create("0x01");
        jobs.start(done);
        jobs.complete(done);
        expect(done).toMatchObject({status: "completed", progress: 100});
        jobs.fail(done, new Error("late"));
        jobs.cancel(done);
        expect(done.status).toBe("completed");

        const cancelled = jobs.create("0x02");
        jobs.start(cancelled);
        jobs.requestCancel(cancelled);
        jobs.complete(cancelled);
        expect(cancelled.status).toBe("cancelled");
        expect(jobs.requestCancel(cancelled)).toBe(false);

        const failing = jobs.create("0x03");
        jobs.start(failing);
        jobs.fail(failing, "plain string");
        expect(failing).toMatchObject({status: "failed", error: "plain string"});
    });

    it("interruptActive marks queued and running jobs interrupted (restart recovery) and frees the slots", () => {
        const {jobs} = store({maxConcurrent: 2});
        const queued = jobs.create("0x01");
        const running = jobs.create("0x02");
        jobs.start(running);
        jobs.interruptActive();

        expect(queued.status).toBe("interrupted");
        expect(running).toMatchObject({status: "interrupted", error: expect.stringContaining("restarted")});
        expect(jobs.activeCount).toBe(0);
        jobs.fail(running, new Error("x"));
        expect(running.status).toBe("interrupted");
    });

    it("list returns copies", () => {
        const {jobs} = store();
        const job = jobs.create("0x01");
        const listed = jobs.list();
        listed[0].status = "failed";

        expect(job.status).toBe("queued");
        expect(jobs.get("job-1")).toBe(job);
    });
});
