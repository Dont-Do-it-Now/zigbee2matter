import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../../../lib/util/logger", () => ({default: {error: vi.fn(), debug: vi.fn(), info: vi.fn(), warning: vi.fn()}}));

import {
    authorizeByScope,
    BRIDGE_REQUEST_SCOPES,
    type Command,
    CommandDeduplicator,
    type CommandResult,
    CommandRetryPolicy,
    CommandRouter,
    DeviceCommandQueue,
    type EntityCommand,
    type ResolvedTarget,
    requiredScope,
} from "../../../lib/command";
import EventBus from "../../../lib/eventBus";

const NOW = 1_000_000;

function entity(requestId: string, value: Record<string, unknown> = {state: "ON"}, extra: Partial<EntityCommand> = {}): EntityCommand {
    return {
        requestId,
        correlationId: `corr-${requestId}`,
        source: "internal",
        identity: {principal: "tester", scope: "control"},
        deadline: NOW + 1_000,
        operation: "set",
        target: {entity: "bulb"},
        value,
        ...extra,
    };
}

function bridgeRequest(
    requestId: string,
    request: string,
    value: Record<string, unknown> = {},
    scope: "read" | "control" | "admin" = "admin",
): Command {
    return {
        requestId,
        correlationId: `corr-${requestId}`,
        source: "internal",
        identity: {principal: "tester", scope},
        deadline: NOW + 1_000,
        operation: "request",
        target: {request},
        value,
    };
}

function setup(options: {hooks?: ConstructorParameters<typeof CommandRouter>[0]["hooks"]; allowed?: Set<string>; retry?: CommandRetryPolicy} = {}) {
    const eventBus = new EventBus();
    const onMessage = vi.fn();
    const bridgeBus = {onMessage} as unknown as ConstructorParameters<typeof CommandRouter>[0]["bridgeBus"];
    const resolve = vi.fn((): ResolvedTarget => ({ok: true, name: "bulb", kind: "device", supported: true, endpointNames: ["l1"]}));
    const router = new CommandRouter({
        eventBus,
        bridgeBus,
        resolver: {resolve},
        authorizer: {authorize: () => ({ok: true})},
        hooks: options.hooks,
        allowedSensitiveRequests: options.allowed,
        retryPolicy: options.retry,
    });
    router.start();

    const publishState = (topic: string, state: Record<string, unknown>): void => {
        eventBus.emitBridgeBusMessagePublished({
            topic,
            payload: JSON.stringify(state),
            options: {clientOptions: {}, baseTopic: "zigbee2matter", skipLog: true, meta: {isEntityState: true}},
        });
    };
    const publishResponse = (payload: Record<string, unknown>): void => {
        eventBus.emitBridgeBusMessagePublished({
            topic: "zigbee2matter/bridge/response/permit_join",
            payload: JSON.stringify(payload),
            options: {clientOptions: {}, baseTopic: "zigbee2matter", skipLog: true, meta: {}},
        });
    };

    return {router, eventBus, onMessage, resolve, publishState, publishResponse};
}

describe("CommandRouter result states", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("injects set as <base>/<name>/set and resolves executed (never confirmed) on a matching state publish", async () => {
        const {router, onMessage, publishState} = setup();
        const promise = router.submit(entity("r1", {state: "ON"}));

        expect(onMessage).toHaveBeenCalledWith("zigbee2matter/bulb/set", JSON.stringify({state: "ON"}));
        publishState("zigbee2matter/bulb", {state: "OFF"});
        publishState("zigbee2matter/bulb", {state: "on", brightness: 1});

        const result = await promise;
        expect(result).toMatchObject({status: "executed", terminal: true, dispatched: true, requestId: "r1"});
        expect(result.status).not.toBe("confirmed");
    });

    it("resolves `unknown` (TIMEOUT) when no state report arrives before the deadline", async () => {
        const {router} = setup();
        const promise = router.submit(entity("r2"));
        await vi.advanceTimersByTimeAsync(1_001);

        expect(await promise).toMatchObject({status: "unknown", errorCode: "TIMEOUT", terminal: true, dispatched: true, retryable: true});
    });

    it("does not rewrite a timed-out result when a late report arrives", async () => {
        const {router, publishState} = setup();
        const promise = router.submit(entity("r3"));
        await vi.advanceTimersByTimeAsync(1_001);
        const result = await promise;
        publishState("zigbee2matter/bulb", {state: "ON"});

        expect(result.status).toBe("unknown");
    });

    it("maps bridge responses by transaction: ok -> executed with data, error -> classified failure", async () => {
        const {router, onMessage, publishResponse} = setup();
        const ok = router.submit(bridgeRequest("p1", "permit_join", {time: 10}));
        const payload = JSON.parse(onMessage.mock.calls[0][1] as string);
        expect(onMessage.mock.calls[0][0]).toBe("zigbee2matter/bridge/request/permit_join");
        expect(payload.transaction).toBe("c3:p1");
        publishResponse({status: "ok", data: {time: 10}, transaction: "c3:p1"});
        expect(await ok).toMatchObject({status: "executed", data: {time: 10}});

        const bad = router.submit(bridgeRequest("p2", "group/rename", {from: "x"}));
        publishResponse({status: "error", error: "Group 'x' does not exist", transaction: "c3:p2"});
        expect(await bad).toMatchObject({status: "failed", errorCode: "NOT_FOUND", dispatched: true});

        const invalid = router.submit(bridgeRequest("p3", "options", {options: 1}));
        publishResponse({status: "error", error: "Invalid payload", transaction: "c3:p3"});
        expect(await invalid).toMatchObject({status: "failed", errorCode: "INVALID_ARGUMENT"});
    });

    it("ignores bridge responses with a foreign or missing transaction", async () => {
        const {router, publishResponse} = setup();
        const promise = router.submit(bridgeRequest("p4", "permit_join", {time: 1}));
        publishResponse({status: "ok", transaction: "other:p4"});
        publishResponse({status: "ok"});
        await vi.advanceTimersByTimeAsync(1_001);

        expect(await promise).toMatchObject({status: "timeout", errorCode: "TIMEOUT"});
    });

    it("rejects the reserved `transaction` key, unknown requests and unauthenticated commands before any injection", async () => {
        const {router, onMessage} = setup();

        expect(await router.submit(bridgeRequest("a", "permit_join", {transaction: "x"}))).toMatchObject({
            errorCode: "INVALID_ARGUMENT",
            dispatched: false,
        });
        expect(await router.submit(bridgeRequest("b", "no/such_request"))).toMatchObject({errorCode: "UNSUPPORTED", dispatched: false});
        expect(await router.submit(entity("c", {state: "ON"}, {identity: {principal: ""}}))).toMatchObject({errorCode: "UNAUTHORIZED"});
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("rejects invalid targets (wildcards, bridge prefix, edge slashes)", async () => {
        const {router, onMessage} = setup();

        for (const name of ["a/#", "a/+/b", "bridge/x", "/a", "a/"]) {
            expect(await router.submit(entity(`t-${name}`, {state: "ON"}, {target: {entity: name}}))).toMatchObject({errorCode: "INVALID_ARGUMENT"});
        }

        expect(onMessage).not.toHaveBeenCalled();
    });

    it("fails with UNAVAILABLE when the router is not running and never throws on malformed input", async () => {
        const {router} = setup();
        router.stop();
        expect(await router.submit(entity("s1"))).toMatchObject({status: "failed", errorCode: "UNAVAILABLE", dispatched: false});

        router.start();
        await expect(router.submit(undefined as unknown as Command)).resolves.toMatchObject({status: "failed"});
    });

    it("stop() settles queued (not injected) commands as failed and injected ones as unknown", async () => {
        const run: Array<() => void> = [];
        const {router, onMessage} = setup({hooks: {schedule: (_c, fn) => void run.push(fn)}});
        const queued = router.submit(entity("q1"));
        router.stop();

        expect(await queued).toMatchObject({status: "failed", errorCode: "UNAVAILABLE", dispatched: false});
        run[0](); // the late runner must not inject after settlement
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("stop() settles an injected command as unknown", async () => {
        const {router} = setup();
        const promise = router.submit(entity("i1"));
        router.stop();

        expect(await promise).toMatchObject({status: "unknown", dispatched: true});
    });
});

describe("Deadline bounds", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("rejects a deadline in the past as timeout and one beyond 10 minutes as invalid", async () => {
        const {router, onMessage} = setup();

        expect(await router.submit(entity("d1", {state: "ON"}, {deadline: NOW}))).toMatchObject({
            status: "timeout",
            errorCode: "TIMEOUT",
            dispatched: false,
        });
        expect(await router.submit(entity("d2", {state: "ON"}, {deadline: NOW + 10 * 60 * 1000 + 1}))).toMatchObject({
            status: "failed",
            errorCode: "INVALID_ARGUMENT",
        });
        expect(await router.submit(entity("d3", {state: "ON"}, {deadline: Number.NaN}))).toMatchObject({errorCode: "TIMEOUT"});
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("accepts exactly the 10 minute upper bound", async () => {
        const {router, onMessage} = setup();
        const promise = router.submit(entity("d4", {state: "ON"}, {deadline: NOW + 10 * 60 * 1000}));
        expect(onMessage).toHaveBeenCalledTimes(1);
        router.stop();
        await promise;
    });
});

describe("Scope table and sensitive requests", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("requires read for get, control for set and the table scope (default admin) for bridge requests", () => {
        expect(requiredScope(entity("g", {state: ""}, {operation: "get"}))).toBe("read");
        expect(requiredScope(entity("s"))).toBe("control");
        expect(requiredScope(bridgeRequest("h", "health_check"))).toBe("read");
        expect(requiredScope(bridgeRequest("n", "never/heard/of/it"))).toBe("admin");
        expect(BRIDGE_REQUEST_SCOPES.get("restart")).toBe("admin");
        expect(BRIDGE_REQUEST_SCOPES.get("permit_join")).toBe("admin");
    });

    it("authorizeByScope: missing/unknown scope is UNAUTHORIZED, insufficient is FORBIDDEN, hierarchy holds", () => {
        const noScope = entity("x", {state: "ON"}, {identity: {principal: "p"}});
        expect(authorizeByScope(noScope)).toMatchObject({ok: false, errorCode: "UNAUTHORIZED"});
        // prototype-chain names must not count as a scope
        const proto = entity("x", {state: "ON"}, {identity: {principal: "p", scope: "constructor" as never}});
        expect(authorizeByScope(proto)).toMatchObject({ok: false, errorCode: "UNAUTHORIZED"});
        expect(authorizeByScope(entity("x", {state: "ON"}, {identity: {principal: "p", scope: "read"}}))).toMatchObject({
            ok: false,
            errorCode: "FORBIDDEN",
        });
        expect(authorizeByScope(entity("x", {state: "ON"}, {identity: {principal: "p", scope: "control"}}))).toStrictEqual({ok: true});
        expect(authorizeByScope(bridgeRequest("x", "restart", {}, "control"))).toMatchObject({ok: false, errorCode: "FORBIDDEN"});
        expect(authorizeByScope(bridgeRequest("x", "restart", {}, "admin"))).toStrictEqual({ok: true});
    });

    it("the router enforces the scope floor before the injected authorizer and before revealing NOT_FOUND", async () => {
        const {router, onMessage, resolve} = setup();
        resolve.mockReturnValueOnce({ok: false, errorCode: "NOT_FOUND", message: "nope"});

        expect(await router.submit(entity("f1", {state: "ON"}, {identity: {principal: "p", scope: "read"}}))).toMatchObject({errorCode: "FORBIDDEN"});
        resolve.mockReturnValueOnce({ok: false, errorCode: "NOT_FOUND", message: "nope"});
        expect(await router.submit(entity("f2", {state: "ON"}))).toMatchObject({errorCode: "NOT_FOUND"});
        expect(onMessage).not.toHaveBeenCalled();
    });

    it.each(["backup", "install_code/add", "device/generate_external_definition"])(
        "rejects sensitive request '%s' with FORBIDDEN by default",
        async (request) => {
            const {router, onMessage} = setup();

            expect(await router.submit(bridgeRequest(`s-${request}`, request, {}))).toMatchObject({
                status: "failed",
                errorCode: "FORBIDDEN",
                dispatched: false,
            });
            expect(onMessage).not.toHaveBeenCalled();
        },
    );

    it("allows a sensitive request only when explicitly allowlisted", async () => {
        const {router, onMessage} = setup({allowed: new Set(["backup"])});
        const promise = router.submit(bridgeRequest("b1", "backup"));

        expect(onMessage).toHaveBeenCalledTimes(1);
        router.stop();
        await promise;
    });
});

describe("Queue stuck prevention and dedup/retry through the router", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("a queued command that hits its deadline is removed and never blocks the next one on the same target", async () => {
        const queue = new DeviceCommandQueue({maxConcurrent: 1});
        const {router, onMessage} = setup({hooks: {schedule: queue.schedule, onResult: queue.onResult}});

        const first = router.submit(entity("k1", {state: "ON"}, {deadline: NOW + 1_000}));
        const second = router.submit(entity("k2", {brightness: 5}, {deadline: NOW + 500}));
        const third = router.submit(entity("k3", {brightness: 9}, {deadline: NOW + 5_000}));

        expect(onMessage).toHaveBeenCalledTimes(1); // only k1 injected, k2/k3 queued behind it

        await vi.advanceTimersByTimeAsync(501);
        expect(await second).toMatchObject({status: "timeout", dispatched: false}); // died in the queue, never injected
        expect(onMessage).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(500);
        expect(await first).toMatchObject({status: "unknown"});

        // k3 starts after k1 released the key; the dead k2 must not be started
        expect(onMessage.mock.calls.map((c) => c[1])).toEqual([JSON.stringify({state: "ON"}), JSON.stringify({brightness: 9})]);
        router.stop();
        await third;
    });

    it("a full queue reports BUSY with dispatched:false and runner exceptions do not stall the key", async () => {
        const queue = new DeviceCommandQueue({maxPending: 1});
        const {router} = setup({hooks: {schedule: queue.schedule, onResult: queue.onResult}});
        const first = router.submit(entity("m1"));
        expect(await router.submit(entity("m2", {brightness: 1}))).toMatchObject({
            status: "failed",
            errorCode: "BUSY",
            dispatched: false,
            retryable: true,
        });
        router.stop();
        await first;

        const errors: unknown[] = [];
        const q2 = new DeviceCommandQueue({onRunError: (_c, e) => errors.push(e)});
        const a = entity("n1");
        const b = entity("n2");
        const ran: string[] = [];
        q2.schedule(a, () => {
            throw new Error("boom");
        });
        q2.schedule(b, () => ran.push("b"));
        expect(errors).toHaveLength(1);
        expect(ran).toEqual(["b"]);
    });

    it("dedup: a dispatched:false failure is forgotten so the same requestId/idempotencyKey can be retried; executed is replayed", () => {
        const dedup = new CommandDeduplicator({now: () => NOW});
        const command = entity("x1", {state: "ON"}, {idempotencyKey: "key-1"});
        const base: CommandResult = {
            requestId: "x1",
            correlationId: "corr-x1",
            status: "failed",
            terminal: true,
            errorCode: "BUSY",
            retryable: true,
            autoRetryAllowed: true,
            dispatched: false,
            at: NOW,
        };

        expect(dedup.admit(command)).toBeUndefined();
        expect(dedup.admit(command)).toMatchObject({errorCode: "CONFLICT"}); // still in flight
        dedup.onResult(base);
        expect(dedup.admit(command)).toBeUndefined(); // 0-RF failure forgotten -> new attempt admitted
        expect(dedup.admit({...command, requestId: "x2"})).toMatchObject({errorCode: "CONFLICT"}); // x1 in flight again

        dedup.onResult({...base, status: "executed", errorCode: undefined, dispatched: true});
        expect(dedup.admit({...command, requestId: "x3"})).toMatchObject({status: "executed", dispatched: false, requestId: "x3"});
    });

    it("dedup: a dispatched failure (timeout) is retained, not forgotten", () => {
        const dedup = new CommandDeduplicator({now: () => NOW});
        const command = entity("y1", {state: "ON"}, {idempotencyKey: "key-y"});
        dedup.admit(command);
        dedup.onResult({
            requestId: "y1",
            correlationId: "corr-y1",
            status: "unknown",
            terminal: true,
            errorCode: "TIMEOUT",
            retryable: true,
            autoRetryAllowed: true,
            dispatched: true,
            at: NOW,
        });

        expect(dedup.admit({...command, requestId: "y2"})).toMatchObject({status: "unknown", dispatched: false});
    });

    it("dedup rejects the same requestId with a different payload and validates maxEntries", () => {
        const dedup = new CommandDeduplicator();
        dedup.admit(entity("z1", {state: "ON"}));
        expect(dedup.admit(entity("z1", {state: "OFF"}))).toMatchObject({errorCode: "CONFLICT"});
        expect(() => new CommandDeduplicator({maxEntries: 0})).toThrow();
    });

    it("retry: idempotent get is resubmitted under a derived id only after a pre-dispatch failure; set with toggle never", async () => {
        const policy = new CommandRetryPolicy({maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10});
        const full = {value: 0};
        const {router, onMessage} = setup({
            retry: policy,
            // biome-ignore lint/complexity/noCommaOperator: compact test hook expressing run-and-return
            hooks: {schedule: (_c, run) => (full.value++ === 0 ? false : (run(), true))},
        });

        const promise = router.submit(entity("g1", {state: ""}, {operation: "get"}));
        await vi.advanceTimersByTimeAsync(20);
        expect(onMessage).toHaveBeenCalledTimes(1); // first attempt BUSY (0 RF), second attempt injected as g1:r2
        expect(onMessage.mock.calls[0][0]).toBe("zigbee2matter/bulb/get");
        router.stop();
        expect(await promise).toMatchObject({requestId: "g1"});

        const toggleFull = {value: 0};
        // biome-ignore lint/complexity/noCommaOperator: compact test hook expressing increment-and-return
        const t = setup({retry: policy, hooks: {schedule: () => (toggleFull.value++, false)}});
        const result = await t.router.submit(entity("t1", {state: "TOGGLE"}));
        await vi.advanceTimersByTimeAsync(100);
        expect(result).toMatchObject({status: "failed", errorCode: "BUSY", autoRetryAllowed: false});
        expect(toggleFull.value).toBe(1);
    });
});

describe("CommandRetryPolicy decisions", () => {
    const policy = new CommandRetryPolicy({maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150});
    const get = entity("rp", {state: ""}, {operation: "get", deadline: 10_000});
    const result: CommandResult = {
        requestId: "rp",
        correlationId: "corr-rp",
        status: "failed",
        terminal: true,
        errorCode: "BUSY",
        retryable: true,
        autoRetryAllowed: true,
        dispatched: false,
        at: 0,
    };

    it("applies exponential backoff capped by maxDelayMs and never exceeds the deadline", () => {
        expect(policy.decide(get, result, 1, 0)).toEqual({retry: true, delayMs: 100, reason: "allowed"});
        expect(policy.decide(get, result, 2, 0)).toEqual({retry: true, delayMs: 150, reason: "allowed"});
        expect(policy.decide(get, result, 3, 0)).toMatchObject({retry: false, reason: "attempt-limit"});
        expect(policy.decide(get, result, 1, 9_950)).toEqual({retry: true, delayMs: 49, reason: "allowed"});
        expect(policy.decide(get, result, 1, 10_000)).toMatchObject({retry: false, reason: "deadline"});
    });

    it("refuses non-retryable, dispatched and non-idempotent (scene/relative/toggle/lock) results", () => {
        expect(policy.decide(get, {...result, retryable: false}, 1, 0).reason).toBe("not-retryable");
        expect(policy.decide(get, {...result, dispatched: true}, 1, 0).reason).toBe("dispatched");
        expect(policy.decide(get, {...result, autoRetryAllowed: false}, 1, 0).reason).toBe("non-idempotent");

        for (const value of [{state: "TOGGLE"}, {state: "LOCK"}, {scene_recall: 1}, {brightness_move: 40}, {color_temp_step: 5}]) {
            expect(policy.decide(entity("np", value), result, 1, 0)).toMatchObject({retry: false, reason: "non-idempotent"});
        }
    });

    it("validates constructor options", () => {
        expect(() => new CommandRetryPolicy({maxAttempts: 0})).toThrow();
        expect(() => new CommandRetryPolicy({baseDelayMs: 10, maxDelayMs: 5})).toThrow();
    });
});
