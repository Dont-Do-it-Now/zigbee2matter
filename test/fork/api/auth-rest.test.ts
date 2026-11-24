import {EventEmitter} from "node:events";
import type {IncomingMessage, ServerResponse} from "node:http";
import {describe, expect, it, vi} from "vitest";

import {
    ApiAuth,
    ApiError,
    authorizeRequest,
    authorizeWebSocket,
    checkOrigin,
    extractToken,
    redactSecrets,
    redactUrl,
    requireScope,
    requiredScope,
    safeEqual,
    toApiError,
    WS_CLOSE_FORBIDDEN,
    WS_CLOSE_UNAUTHORIZED,
} from "../../../lib/api/auth";
import {RestApiRouter, type RestRouterDeps} from "../../../lib/api";

const HASH = "a".repeat(64);

describe("ApiAuth", () => {
    it("never accepts prototype-chain names as a secret or a scope", () => {
        const auth = new ApiAuth({}, []);
        for (const secret of ["constructor", "__proto__", "toString", "hasOwnProperty", "admin", "read"]) {
            expect(auth.verify(secret)).toBeUndefined();
            expect(() => auth.authenticate(secret)).toThrow(ApiError);
        }

        expect(() => requireScope({tokenId: "x", scope: "constructor" as never, source: "token"}, "read")).toThrow(/Insufficient scope/);
        expect(() => requireScope({tokenId: "x", scope: "admin", source: "token"}, "__proto__" as never)).toThrow(/Insufficient scope/);
        expect(() => auth.issue("constructor" as never)).toThrow(ApiError);
    });

    it("discards persisted records with invalid scope/hash and warns without leaking the hash", () => {
        const warn = vi.fn();
        const auth = new ApiAuth({warn}, [
            {id: "ok", hash: HASH, scope: "read"},
            {id: "bad-scope", hash: HASH, scope: "toString" as never},
            {id: "bad-hash", hash: "xyz", scope: "read"},
            {id: "", hash: HASH, scope: "read"},
            null as never,
        ]);

        expect(auth.list().map((t) => t.id)).toEqual(["ok"]);
        expect(warn).toHaveBeenCalledTimes(4);
        for (const [message] of warn.mock.calls) expect(String(message)).not.toContain(HASH);
    });

    it("issues, verifies, expires and revokes tokens; the secret is only returned once and no hash leaks via list()", () => {
        let now = 1_000;
        const changes: unknown[] = [];
        const auth = new ApiAuth({now: () => now, onChange: (records) => changes.push(records)});
        const {id, secret, info} = auth.issue("control", {ttlMs: 100, label: "ci"});

        expect(info).toMatchObject({id, scope: "control", label: "ci", expiresAt: 1_100});
        expect(JSON.stringify(auth.list())).not.toContain(secret);
        expect(Object.keys(auth.list()[0])).not.toContain("hash");
        expect(auth.verify(secret)).toEqual({tokenId: id, scope: "control", source: "token"});
        now = 1_100;
        expect(auth.verify(secret)).toBeUndefined();

        const second = auth.issue("read");
        expect(auth.verify(second.secret)?.scope).toBe("read");
        auth.revoke(second.id);
        expect(auth.verify(second.secret)).toBeUndefined();
        expect(() => auth.revoke(second.id)).toThrow(/Token not found/);
        expect(() => auth.issue("read", {ttlMs: -1})).toThrow(ApiError);
        expect(() => auth.issue("read", {ttlMs: 1.5})).toThrow(ApiError);
        expect(changes.length).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(changes)).not.toContain(secret);
    });

    it("fails closed: no credentials is UNAUTHORIZED, empty/malformed bearer is UNAUTHORIZED even with anonymousScope", () => {
        expect(() => new ApiAuth().authenticate(undefined)).toThrow(/Authentication required/);
        const anonymous = new ApiAuth({anonymousScope: "read"});
        expect(anonymous.authenticate(undefined)).toMatchObject({scope: "read", source: "anonymous"});
        expect(() => anonymous.authenticate("")).toThrow(ApiError);
        expect(() => anonymous.authenticate("wrong")).toThrow(ApiError);
    });

    it("accepts the legacy auth_token as admin and compares in constant time form", () => {
        const auth = new ApiAuth({legacyToken: "legacy-secret"});
        expect(auth.verify("legacy-secret")).toEqual({tokenId: "legacy", scope: "admin", source: "legacy"});
        expect(auth.verify("legacy-secre")).toBeUndefined();
        expect(safeEqual("a", "a")).toBe(true);
        expect(safeEqual("a", "aa")).toBe(false);
    });
});

describe("requiredScope path normalization", () => {
    it.each([
        ["GET", "/devices", "read"],
        ["GET", "/groups", "read"],
        ["HEAD", "/jobs", "read"],
        ["GET", "/commands", "read"],
        ["POST", "/commands", "control"],
        ["POST", "/jobs", "control"],
        ["GET", "/tokens", "admin"],
        ["GET", "/diagnostics", "admin"],
        ["GET", "/bridges", "admin"],
        ["PATCH", "/devices/x", "admin"],
        ["DELETE", "/commands", "admin"],
        ["GET", "/unknown", "admin"],
        ["GET", "/", "admin"],
    ])("%s %s -> %s", (method, path, scope) => {
        expect(requiredScope(method, path)).toBe(scope);
    });

    it.each([
        "/devices/",
        "//devices",
        "/devices//x",
        "/devices/../tokens",
        "/devices/./x",
        "/devices/%2e%2e/tokens",
        "/devices%2Ftokens",
        "/devices/%2E",
        "/devices\\x",
        "/devices/%5cx",
    ])(
        "rejects %s instead of guessing a scope",
        (path) => {
            expect(() => requiredScope("GET", path)).toThrow(/Invalid path/);
        },
    );
});

describe("token extraction, origin and websocket authorization", () => {
    it("prefers the Authorization header; query token only when allowed; malformed bearer yields an empty (failing) credential", () => {
        expect(extractToken({headers: {authorization: "Bearer abc"}})).toBe("abc");
        expect(extractToken({headers: {authorization: "bearer   abc"}})).toBe("abc");
        expect(extractToken({headers: {authorization: "Basic abc"}})).toBe("");
        expect(extractToken({headers: {authorization: "Bearer a b"}})).toBe("");
        expect(extractToken({headers: {authorization: "Bearer abc"}, url: "/x?token=q"}, {allowQueryToken: true})).toBe("abc");
        expect(extractToken({headers: {}, url: "/x?token=q"})).toBeUndefined();
        expect(extractToken({headers: {}, url: "/x?token=q"}, {allowQueryToken: true})).toBe("q");
        expect(extractToken({headers: {authorization: ["Bearer first", "Bearer second"]}})).toBe("first");
    });

    it("checkOrigin: no Origin passes, same-host/allowlist pass, foreign and malformed origins are FORBIDDEN", () => {
        expect(() => checkOrigin({headers: {}})).not.toThrow();
        expect(() => checkOrigin({headers: {origin: "http://app.local:8080", host: "app.local:8080"}})).not.toThrow();
        expect(() => checkOrigin({headers: {origin: "http://evil.example", host: "app.local:8080"}})).toThrow(/Origin not allowed/);
        expect(() => checkOrigin({headers: {origin: "not a url"}})).toThrow(/Origin not allowed/);
        expect(() => checkOrigin({headers: {origin: "http://x.example", host: "x.example"}}, {allowSameHost: false})).toThrow(ApiError);
        expect(() =>
            checkOrigin({headers: {origin: "https://ui.example"}}, {allowedOrigins: ["https://ui.example"], allowSameHost: false}),
        ).not.toThrow();
    });

    it("authorizeRequest maps failures to UNAUTHORIZED/FORBIDDEN and enforces scope per route", () => {
        const auth = new ApiAuth();
        const read = auth.issue("read").secret;
        const admin = auth.issue("admin").secret;
        const request = (secret: string | undefined, method: string) => ({method, headers: secret ? {authorization: `Bearer ${secret}`} : {}});

        expect(authorizeRequest(auth, request(read, "GET"), "/devices").scope).toBe("read");
        expect(() => authorizeRequest(auth, request(undefined, "GET"), "/devices")).toThrow(expect.objectContaining({code: "UNAUTHORIZED"}));
        expect(() => authorizeRequest(auth, request(read, "POST"), "/commands")).toThrow(expect.objectContaining({code: "FORBIDDEN"}));
        expect(() => authorizeRequest(auth, request(read, "GET"), "/tokens")).toThrow(expect.objectContaining({code: "FORBIDDEN"}));
        expect(authorizeRequest(auth, request(admin, "GET"), "/tokens").scope).toBe("admin");
        expect(() => authorizeRequest(auth, request(admin, "GET"), "/devices/../tokens")).toThrow(
            expect.objectContaining({code: "INVALID_ARGUMENT"}),
        );
    });

    it("authorizeWebSocket returns close codes without secrets", () => {
        const auth = new ApiAuth();
        const secret = auth.issue("read").secret;

        expect(authorizeWebSocket(auth, {headers: {}, url: `/events?token=${secret}`})).toMatchObject({ok: true});
        expect(authorizeWebSocket(auth, {headers: {}, url: "/events?token=nope"})).toEqual({
            ok: false,
            closeCode: WS_CLOSE_UNAUTHORIZED,
            reason: "Invalid or expired token",
        });
        expect(authorizeWebSocket(auth, {headers: {}})).toMatchObject({ok: false, closeCode: WS_CLOSE_UNAUTHORIZED});
        expect(authorizeWebSocket(auth, {headers: {origin: "http://evil.example", host: "app", authorization: `Bearer ${secret}`}})).toMatchObject({
            ok: false,
            closeCode: WS_CLOSE_FORBIDDEN,
        });
    });
});

describe("error mapping and redaction", () => {
    it("maps service errors by C6 code and hides the original message; unknown errors become INTERNAL", () => {
        const unavailable = toApiError(Object.assign(new Error("db at /secret/path exploded"), {code: "UNAVAILABLE"}));
        expect(unavailable).toMatchObject({code: "UNAVAILABLE", httpStatus: 503, retryable: true, message: "Service unavailable"});
        expect(toApiError(Object.assign(new Error("x"), {code: "BUSY"}))).toMatchObject({httpStatus: 429, retryable: true});
        expect(toApiError(Object.assign(new Error("x"), {code: "CONFLICT"}))).toMatchObject({httpStatus: 409, retryable: false});
        // auth codes are decided by the auth layer only, never accepted from a service error
        expect(toApiError(Object.assign(new Error("x"), {code: "UNAUTHORIZED"}))).toMatchObject({code: "INTERNAL", httpStatus: 500});
        expect(toApiError(new Error("stack /secret"))).toMatchObject({code: "INTERNAL", message: "Internal error"});
        expect(toApiError("string")).toMatchObject({code: "INTERNAL"});
    });

    it("redacts secrets (nested, arrays, circular) and token query values", () => {
        const input: Record<string, unknown> = {name: "a", token: "t", nested: {Password: "p", list: [{api_key: "k"}, 1]}, network_key: [1, 2]};
        input.self = input;
        const out = redactSecrets(input) as Record<string, unknown>;

        expect(out.token).toBe("[REDACTED]");
        expect(out.network_key).toBe("[REDACTED]");
        expect(JSON.stringify(out)).not.toMatch(/"p"|"k"|"t"/);
        expect(out.self).toBe("[Circular]");
        expect(redactUrl("/events?a=1&token=abc123&b=2")).toBe("/events?a=1&token=[REDACTED]&b=2");
    });
});

// ---- REST router -------------------------------------------------------------------------------------------------

interface Reply {
    status: number;
    headers: Record<string, string | number>;
    body: any;
}

function request(
    router: RestApiRouter,
    method: string,
    url: string,
    options: {secret?: string; body?: unknown; headers?: Record<string, string>} = {},
): Promise<Reply> {
    return new Promise((resolve) => {
        const req = new EventEmitter() as EventEmitter & Partial<IncomingMessage> & {destroy: () => void};
        req.method = method;
        req.url = url;
        req.headers = {host: "localhost", ...(options.secret ? {authorization: `Bearer ${options.secret}`} : {}), ...options.headers};
        req.socket = {remoteAddress: "127.0.0.1"} as IncomingMessage["socket"];
        req.destroy = () => undefined;
        const headers: Record<string, string | number> = {};
        const res = {
            statusCode: 200,
            setHeader: (name: string, value: string | number) => {
                headers[name.toLowerCase()] = value;
            },
            end: (payload?: string) => resolve({status: res.statusCode, headers, body: payload ? JSON.parse(payload) : undefined}),
        } as unknown as ServerResponse & {statusCode: number};

        router.handle(req as IncomingMessage, res);

        if (options.body !== undefined) req.emit("data", Buffer.from(JSON.stringify(options.body)));
        req.emit("end");
    });
}

function makeRouter(overrides: Partial<RestRouterDeps> = {}) {
    const auth = new ApiAuth();
    const secrets = {read: auth.issue("read").secret, control: auth.issue("control").secret, admin: auth.issue("admin").secret};
    const settings = {current: {friendly_name: "lamp", retain: false} as unknown};
    const executeCommand = vi.fn(async (_input: unknown) => ({status: "executed"}));
    const router = new RestApiRouter({
        auth,
        listDevices: () => [{id: "0x1", name: "lamp", available: true, token: "leak"} as never],
        settings: {read: (_kind, id) => (id === "missing" ? undefined : settings.current)},
        executeCommand,
        ...overrides,
    });

    return {router, secrets, settings, executeCommand, auth};
}

describe("RestApiRouter", () => {
    it("serves GET /devices to read tokens, redacts secrets and rejects missing credentials", async () => {
        const {router, secrets} = makeRouter();

        const ok = await request(router, "GET", "/api/v1/devices", {secret: secrets.read});
        expect(ok.status).toBe(200);
        expect(ok.body.devices[0].token).toBe("[REDACTED]");
        expect((await request(router, "GET", "/api/v1/devices")).status).toBe(401);
        expect((await request(router, "GET", "/other")).status).toBe(404);
    });

    it("normalizes exactly one trailing slash, rejects extra slashes and traversal without ever reaching admin routes", async () => {
        const {router, secrets} = makeRouter();

        expect((await request(router, "GET", "/api/v1/devices/", {secret: secrets.read})).status).toBe(200);
        expect((await request(router, "GET", "/api/v1/devices//", {secret: secrets.read})).status).toBe(400);
        expect((await request(router, "GET", "/api/v1//devices", {secret: secrets.read})).status).toBe(400);

        for (const url of ["/api/v1/devices/../tokens", "/api/v1/devices/%2e%2e/tokens", "/api/v1/devices%2Ftokens", "/api/v1/devices/..%2ftokens"]) {
            const reply = await request(router, "GET", url, {secret: secrets.read});
            expect(reply.status, url).not.toBe(200);
            expect([400, 403, 404], url).toContain(reply.status);
            expect(reply.body.tokens).toBeUndefined();
        }

        expect((await request(router, "GET", "/api/v1/tokens", {secret: secrets.read})).status).toBe(403);
        expect((await request(router, "GET", "/api/v1/tokens", {secret: secrets.admin})).status).toBe(200);
    });

    it("never echoes token hashes or secrets from /tokens", async () => {
        const {router, secrets} = makeRouter();
        const reply = await request(router, "GET", "/api/v1/tokens", {secret: secrets.admin});

        expect(JSON.stringify(reply.body)).not.toContain(secrets.admin);
        expect(JSON.stringify(reply.body)).not.toMatch(/"hash"/);
    });

    it("PATCH requires admin and a revision; a stale revision is 409 CONFLICT and never executes", async () => {
        const {router, secrets, executeCommand} = makeRouter();
        const body = {options: {retain: true}};

        expect((await request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.control, body})).status).toBe(403);
        expect((await request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.admin, body})).status).toBe(400); // no revision
        expect((await request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.admin, body: {options: 1}})).status).toBe(400);

        const stale = await request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.admin, body, headers: {"if-match": '"deadbeef"'}});
        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe("CONFLICT");
        const staleBody = await request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.admin, body: {...body, revision: "deadbeef"}});
        expect(staleBody.status).toBe(409);
        expect(executeCommand).not.toHaveBeenCalled();
    });

    it("PATCH with the current revision (If-Match from GET, weak or strong) delegates to the command router", async () => {
        const {router, secrets, executeCommand} = makeRouter();
        const read = await request(router, "GET", "/api/v1/devices/lamp/settings", {secret: secrets.read});
        expect(read.status).toBe(200);
        const revision = read.body.revision as string;
        expect(read.headers.etag).toBe(`"${revision}"`);

        const patched = await request(router, "PATCH", "/api/v1/devices/lamp", {
            secret: secrets.admin,
            body: {options: {retain: true}},
            headers: {"if-match": `W/"${revision}"`},
        });
        expect(patched.status).toBe(202);
        expect(patched.body.previousRevision).toBe(revision);
        expect(executeCommand).toHaveBeenCalledTimes(1);
        const [command] = executeCommand.mock.calls[0] as [Record<string, any>];
        expect(command).toMatchObject({operation: "request", target: {request: "device/options"}, value: {id: "lamp", options: {retain: true}}});
        expect(command.deadline).toBeGreaterThan(Date.now());
    });

    it("PATCH of bridges uses `options`, groups use `group/options`; unknown resource is 404; settings API missing is 501", async () => {
        const {router, secrets, executeCommand} = makeRouter();
        const revision = (await request(router, "GET", "/api/v1/groups/g1/settings", {secret: secrets.read})).body.revision;
        await request(router, "PATCH", "/api/v1/groups/g1", {secret: secrets.admin, body: {options: {a: 1}, revision}});
        await request(router, "PATCH", "/api/v1/bridges/b1", {secret: secrets.admin, body: {options: {a: 1}, revision}});
        expect((executeCommand.mock.calls[0][0] as any).target.request).toBe("group/options");
        expect((executeCommand.mock.calls[1][0] as any).target).toEqual({request: "options"});
        expect((executeCommand.mock.calls[1][0] as any).value).toEqual({options: {a: 1}});

        expect((await request(router, "GET", "/api/v1/devices/missing/settings", {secret: secrets.read})).status).toBe(404);

        const noSettings = makeRouter({settings: undefined});
        expect((await request(noSettings.router, "GET", "/api/v1/devices/x/settings", {secret: noSettings.secrets.read})).status).toBe(501);
    });

    it("rejects a concurrent PATCH of the same resource with 409 while the first is in flight", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const {router, secrets} = makeRouter({executeCommand: async () => (await gate, {status: "executed"})});
        const revision = (await request(router, "GET", "/api/v1/devices/lamp/settings", {secret: secrets.read})).body.revision;
        const first = request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.admin, body: {options: {a: 1}, revision}});
        const second = await request(router, "PATCH", "/api/v1/devices/lamp", {secret: secrets.admin, body: {options: {a: 2}, revision}});

        expect(second.status).toBe(409);
        release();
        expect((await first).status).toBe(202);
    });

    it("C6: a service error with code UNAVAILABLE becomes HTTP 503 with a sanitized retryable body", async () => {
        const failure = Object.assign(new Error("zigbee adapter at COM3 token=abc failed"), {code: "UNAVAILABLE"});
        const {router, secrets} = makeRouter({
            executeCommand: async () => {
                throw failure;
            },
        });
        const reply = await request(router, "POST", "/api/v1/commands", {secret: secrets.control, body: {x: 1}});

        expect(reply.status).toBe(503);
        expect(reply.body).toEqual({error: {code: "UNAVAILABLE", message: "Service unavailable", retryable: true}});
        expect(JSON.stringify(reply.body)).not.toMatch(/COM3|token=abc/);
    });

    it("C6: unexpected errors are 500 INTERNAL without message leakage; a missing executor is 501", async () => {
        const {router, secrets} = makeRouter({
            executeCommand: async () => {
                throw new Error("boom /etc/secret");
            },
        });
        const reply = await request(router, "POST", "/api/v1/commands", {secret: secrets.control, body: {x: 1}});
        expect(reply.status).toBe(500);
        expect(JSON.stringify(reply.body)).not.toContain("/etc/secret");

        const none = makeRouter({executeCommand: undefined});
        expect((await request(none.router, "POST", "/api/v1/commands", {secret: none.secrets.control, body: {}})).status).toBe(501);
    });

    it("limits the request body size and invalid JSON returns 400", async () => {
        const {router, secrets} = makeRouter({maxBodyBytes: 1024});
        const big = await request(router, "POST", "/api/v1/tokens", {secret: secrets.admin, body: {scope: "read", label: "x".repeat(2000)}});
        expect(big.status).toBe(400);
        expect(() => makeRouter({maxBodyBytes: 10})).toThrow();
    });

    it("POST /tokens validates scope/label/ttl and DELETE revokes (404 for unknown)", async () => {
        const {router, secrets} = makeRouter();

        expect((await request(router, "POST", "/api/v1/tokens", {secret: secrets.admin, body: {scope: "root"}})).status).toBe(400);
        expect((await request(router, "POST", "/api/v1/tokens", {secret: secrets.admin, body: {scope: "constructor"}})).status).toBe(400);
        const created = await request(router, "POST", "/api/v1/tokens", {secret: secrets.admin, body: {scope: "read", label: "kiosk"}});
        expect(created.status).toBe(201);
        expect(created.body.secret).toEqual(expect.any(String));
        expect((await request(router, "DELETE", `/api/v1/tokens/${created.body.id}`, {secret: secrets.admin})).status).toBe(200);
        expect((await request(router, "DELETE", `/api/v1/tokens/${created.body.id}`, {secret: secrets.admin})).status).toBe(404);
        expect((await request(router, "DELETE", "/api/v1/tokens/a%2Fb", {secret: secrets.admin})).status).toBe(400);
    });
});
