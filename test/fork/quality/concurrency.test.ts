import {describe, expect, it} from "vitest";

import {
    CommandDeduplicator,
    CommandLoopGuard,
    CommandRetryPolicy,
    DeviceCommandQueue,
    type Command,
    type CommandResult,
    type EntityCommand,
} from "../../../lib/command";
import {EventStream, PlatformFanout, type BridgeEvent, type Platform} from "../../../lib/events";

const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

function makeCommand(
    requestId: string,
    entity: string,
    value: Record<string, unknown> = {state: "ON"},
    overrides: Partial<EntityCommand> = {},
): EntityCommand {
    return {
        requestId,
        correlationId: `corr-${requestId}`,
        source: "internal",
        identity: {principal: "fixture"},
        deadline: 1_000,
        operation: "set",
        target: {entity},
        value,
        ...overrides,
    };
}

function terminalResult(command: Command, status: CommandResult["status"] = "executed"): CommandResult {
    return {
        requestId: command.requestId,
        correlationId: command.correlationId,
        status,
        terminal: true,
        retryable: false,
        autoRetryAllowed: true,
        dispatched: true,
        at: 500,
    };
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });

    return {promise, resolve};
}

describe("T069 deterministic concurrency harness", () => {
    it("delivers concurrent ON/OFF revisions to four isolated consumers in order", async () => {
        const stream = new EventStream(16);
        const fanout = new PlatformFanout(stream);
        const platforms: Platform[] = ["matter", "http", "ws", "internal"];
        const received = new Map<Platform, BridgeEvent[]>();

        for (const platform of platforms) {
            received.set(platform, []);
            fanout.subscribe(`consumer-${platform}`, platform, (event) => {
                received.get(platform)?.push(event);
            });
        }

        stream.publish("delta", "device/0x01", {state: "ON"}, {revision: 41});
        stream.publish("delta", "device/0x01", {state: "OFF"}, {revision: 42});
        await settle();

        for (const platform of platforms) {
            const events = received.get(platform) ?? [];
            expect(events.map((event) => event.sequence)).toEqual([1, 2]);
            expect(events.map((event) => event.revision)).toEqual([41, 42]);
            expect(events.map((event) => (event.payload as {state: string}).state)).toEqual(["ON", "OFF"]);
        }
    });

    it("keeps a button burst as distinct transient events", () => {
        const stream = new EventStream(32);

        for (let count = 1; count <= 8; count++) {
            stream.publish("transient", "device/0x01", {action: "button", count}, {correlationId: `press-${count}`});
        }

        const replay = stream.replay(0);
        expect(replay.resync).toBe(false);
        if (!replay.resync) {
            expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
            expect(replay.events.map((event) => event.correlationId)).toEqual([
                "press-1",
                "press-2",
                "press-3",
                "press-4",
                "press-5",
                "press-6",
                "press-7",
                "press-8",
            ]);
        }
    });

    it("isolates a slow consumer and continues after a listener error", async () => {
        const stream = new EventStream(16);
        const fanout = new PlatformFanout(stream);
        const gate = deferred<void>();
        const slowSequences: number[] = [];
        const fastSequences: number[] = [];
        const drops: number[] = [];
        let firstSlowEvent = true;

        fanout.subscribe(
            "slow",
            "ws",
            async (event) => {
                slowSequences.push(event.sequence);
                if (firstSlowEvent) {
                    firstSlowEvent = false;
                    await gate.promise;
                }

                if (event.sequence === 3) {
                    throw new Error("fixture listener failure");
                }
            },
            {maxQueue: 2, onDrop: ({event}) => drops.push(event.sequence)},
        );
        fanout.subscribe("fast", "internal", (event) => fastSequences.push(event.sequence));

        stream.publish("delta", "device/0x01", {state: "ON"}, {revision: 1});
        stream.publish("delta", "device/0x01", {state: "OFF"}, {revision: 2});
        stream.publish("delta", "device/0x01", {state: "ON"}, {revision: 3});
        stream.publish("delta", "device/0x01", {state: "OFF"}, {revision: 4});
        await settle();

        expect(fastSequences).toEqual([1, 2, 3, 4]);
        expect(drops).toHaveLength(1);
        expect(fanout.stats("slow")).toMatchObject({dropped: 1, queued: 2});

        gate.resolve(undefined);
        await settle();
        await settle();

        expect(slowSequences[0]).toBe(1);
        expect(slowSequences).toContain(4);
        expect(fanout.stats("slow")).toMatchObject({errors: 1, dropped: 1});
    });

    it("replays missed events after reconnect and requests resync across epochs", () => {
        const stream = new EventStream(8);
        const firstEpoch = stream.epoch;
        stream.publish("delta", "device/0x01", {state: "ON"}, {revision: 1});
        const cursor = stream.lastSequence;

        stream.publish("delta", "device/0x01", {state: "OFF"}, {revision: 2});
        stream.publish("delta", "device/0x01", {state: "ON"}, {revision: 3});
        const reconnect = stream.replay(cursor, firstEpoch);

        expect(reconnect.resync).toBe(false);
        if (!reconnect.resync) {
            expect(reconnect.events.map((event) => event.sequence)).toEqual([2, 3]);
            expect(reconnect.events.map((event) => event.revision)).toEqual([2, 3]);
        }

        stream.resetEpoch();
        expect(stream.replay(cursor, firstEpoch)).toMatchObject({resync: true, reason: "epoch"});
    });

    it("keeps timeout retry deterministic and forbids non-idempotent retry", () => {
        const policy = new CommandRetryPolicy({maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 100});
        const read = makeCommand("read-1", "device/0x01", {}, {operation: "get"});
        const retryable: CommandResult = {
            ...terminalResult(read, "timeout"),
            retryable: true,
            autoRetryAllowed: true,
        };

        expect(policy.decide(read, retryable, 1, 100)).toEqual({retry: true, delayMs: 50, reason: "allowed"});
        expect(policy.decide(read, retryable, 2, 100)).toMatchObject({retry: false, reason: "attempt-limit"});
        expect(policy.decide(read, retryable, 1, 1_000)).toEqual({retry: false, delayMs: 0, reason: "deadline"});

        const toggle = makeCommand("toggle-1", "device/0x01", {state: "toggle"});
        expect(policy.decide(toggle, {...retryable, requestId: toggle.requestId, correlationId: toggle.correlationId}, 1, 100)).toEqual({
            retry: false,
            delayMs: 0,
            reason: "non-idempotent",
        });
    });

    it("serializes group/member collisions while allowing a disjoint device", () => {
        const runs: string[] = [];
        const queue = new DeviceCommandQueue({
            maxConcurrent: 2,
            keyResolver: (command) => command.target.entity === "group/1" ? ["device/a", "device/b"] : [command.target.entity],
        });
        const group = makeCommand("group-1", "group/1");
        const member = makeCommand("member-a", "device/a");
        const disjoint = makeCommand("device-c", "device/c");

        expect(queue.schedule(group, () => runs.push("group"))).toBe(true);
        expect(queue.schedule(member, () => runs.push("member-a"))).toBe(true);
        expect(queue.schedule(disjoint, () => runs.push("device-c"))).toBe(true);
        expect(runs).toEqual(["group", "device-c"]);

        queue.onResult(terminalResult(group));
        expect(runs).toEqual(["group", "device-c", "member-a"]);

        queue.onResult(terminalResult(disjoint));
        queue.onResult(terminalResult(member));
        expect(runs).toHaveLength(3);
    });

    it("replays completed idempotent commands without RF and diagnoses loops", () => {
        const command = makeCommand("request-1", "device/0x01", {state: "ON"}, {idempotencyKey: "same-key"});
        const deduplicator = new CommandDeduplicator({now: () => 500});
        const firstAdmission = deduplicator.admit(command);
        expect(firstAdmission).toBeUndefined();
        deduplicator.onResult(terminalResult(command));

        const replay = deduplicator.admit({...command, requestId: "request-2", correlationId: "corr-request-2"});
        expect(replay).toMatchObject({status: "executed", dispatched: false, requestId: "request-2"});

        const conflict = deduplicator.admit({...command, requestId: "request-3", correlationId: "corr-request-3", value: {state: "OFF"}});
        expect(conflict).toMatchObject({status: "failed", errorCode: "CONFLICT", dispatched: false});

        let now = 100;
        const repeats: number[] = [];
        const guard = new CommandLoopGuard({now: () => now, onRepeat: ({count}) => repeats.push(count)});
        expect(guard.record(command).repeated).toBe(false);
        now += 10;
        expect(guard.record(command)).toMatchObject({repeated: true, count: 2});
        expect(repeats).toEqual([2]);
    });
});
