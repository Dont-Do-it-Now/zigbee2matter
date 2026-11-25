/** C7 REST 라우팅 경계(T056). 기존 frontend HTTP 서버에 주입할 수 있는 Node handler. */
import {createHash, randomUUID} from "node:crypto";
import type {IncomingMessage, ServerResponse} from "node:http";
import {authorizeRequest, type ApiAuth, type Principal, type Scope, ApiError, redactSecrets, toApiError} from "./auth";
import {AuthFailureRateLimiter} from "./rateLimit";
import {BackupInputError} from "../storage/backup";

export interface RestDevice {
    readonly id: string;
    readonly name?: string;
    readonly available: boolean;
    readonly entities?: readonly unknown[];
}

export interface RestGroup {
    readonly id: number;
    readonly name: string;
    readonly available: boolean;
    readonly members: readonly {readonly ieeeAddress: string; readonly endpoint: number}[];
}

export interface RestBridge {
    readonly id: string;
    readonly networkId: string;
    readonly matterEnabled: boolean;
    readonly matterRunning: boolean;
}

export type SettingsKind = "devices" | "groups" | "bridges";

/** 설정 PATCH 대상의 현재 설정 조회. 없으면 undefined. revision은 이 값의 안정 해시(서비스가 별도 revision을 제공하지 않음, C7). */
export interface RestSettingsProvider {
    read(kind: SettingsKind, id: string): unknown;
}

/** Matter 매핑 미지원 기능(lib/matter 팩토리의 `unsupported`/`unsupportedFor`) 공급자. controller 연결은 통합 담당. */
export interface RestUnsupportedFeatureProvider {
    list(): readonly unknown[];
    forEndpoint(endpointId: string): readonly unknown[];
}

export interface RestRouterDeps {
    readonly auth: ApiAuth;
    readonly listDevices: () => readonly RestDevice[];
    readonly listGroups?: () => readonly unknown[];
    readonly listJobs?: () => readonly unknown[];
    readonly listBridges?: () => readonly unknown[];
    readonly listDiagnostics?: () => unknown;
    readonly settings?: RestSettingsProvider;
    readonly unsupportedFeatures?: RestUnsupportedFeatureProvider;
    readonly executeCommand?: (input: unknown, principal: Principal) => Promise<unknown>;
    readonly runMigration?: (input: unknown, principal: Principal) => Promise<unknown>;
    readonly backup?: {
        readonly create: (passphrase: string) => Promise<void>;
        readonly restore: (passphrase: string) => Promise<void>;
    };
    readonly matterManagement?: {
        readonly commissioningWindow?: () => unknown;
        readonly openCommissioningWindow?: (input: unknown) => Promise<unknown>;
        readonly closeCommissioningWindow?: () => Promise<boolean>;
        readonly listFabrics?: () => readonly unknown[];
        readonly listEndpoints?: () => readonly unknown[];
    };
    readonly origin?: {allowedOrigins?: readonly string[]; allowSameHost?: boolean};
    readonly maxBodyBytes?: number;
    readonly authFailureRateLimiter?: AuthFailureRateLimiter;
}

export class RestApiRouter {
    private readonly maxBodyBytes: number;
    private readonly patching = new Set<string>();

    constructor(private readonly deps: RestRouterDeps) {
        const maxBodyBytes = deps.maxBodyBytes ?? 1_048_576;
        if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new Error("maxBodyBytes must be an integer of at least 1024");
        this.maxBodyBytes = maxBodyBytes;
    }

    handle(req: IncomingMessage, res: ServerResponse): void {
        void this.dispatch(req, res).catch((error: unknown) => this.writeError(res, toApiError(error)));
    }

    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let url: URL;
        try {
            url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        } catch {
            throw new ApiError("INVALID_ARGUMENT", "Invalid request URL");
        }
        const prefix = "/api/v1";
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
            this.writeError(res, new ApiError("NOT_FOUND", "Not found"));
            return;
        }

        let pathname = url.pathname.slice(prefix.length) || "/";
        // 끝 `/` 하나는 인증 판정 전에 정규화한다(`//`는 남아서 requiredScope가 거부).
        if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
        const clientKey = req.socket.remoteAddress ?? "unknown";
        let principal: Principal;
        try {
            principal = authorizeRequest(this.deps.auth, {method: req.method ?? "GET", headers: req.headers, url: req.url}, pathname, {
                origin: this.deps.origin,
            });
            this.deps.authFailureRateLimiter?.reset(clientKey);
        } catch (error) {
            const apiError = toApiError(error);
            if (apiError.code === "UNAUTHORIZED" && this.deps.authFailureRateLimiter) {
                if (!this.deps.authFailureRateLimiter.allow(clientKey)) throw new ApiError("BUSY", "Too many authentication failures");
                this.deps.authFailureRateLimiter.recordFailure(clientKey);
            }
            throw apiError;
        }

        if (req.method === "GET" && pathname === "/devices") {
            this.writeJson(res, 200, {devices: this.deps.listDevices().map((device) => redactSecrets(device))});
            return;
        }
        if (req.method === "GET" && pathname === "/groups") {
            if (!this.deps.listGroups) throw new ApiError("NOT_FOUND", "Groups unavailable");
            this.writeJson(res, 200, {groups: this.deps.listGroups().map((group) => redactSecrets(group))});
            return;
        }
        if (req.method === "GET" && pathname === "/jobs") {
            if (!this.deps.listJobs) throw new ApiError("NOT_FOUND", "Jobs unavailable");
            this.writeJson(res, 200, {jobs: this.deps.listJobs().map((job) => redactSecrets(job))});
            return;
        }
        if (req.method === "GET" && pathname === "/bridges") {
            if (!this.deps.listBridges) throw new ApiError("NOT_FOUND", "Bridges unavailable");
            this.writeJson(res, 200, {bridges: this.deps.listBridges().map((bridge) => redactSecrets(bridge))});
            return;
        }
        if (req.method === "GET" && pathname === "/diagnostics") {
            if (!this.deps.listDiagnostics) throw new ApiError("NOT_FOUND", "Diagnostics unavailable");
            this.writeJson(res, 200, redactSecrets(this.deps.listDiagnostics()));
            return;
        }
        if (req.method === "GET" && (pathname === "/diagnostics/unsupported" || pathname.startsWith("/diagnostics/unsupported/"))) {
            const provider = this.deps.unsupportedFeatures;
            if (!provider) throw new ApiError("NOT_FOUND", "Unsupported feature diagnostics unavailable");
            if (pathname === "/diagnostics/unsupported") {
                this.writeJson(res, 200, {unsupported: redactSecrets(provider.list())});
                return;
            }
            const endpointId = decodeId(pathname.slice("/diagnostics/unsupported/".length), "endpoint id");
            this.writeJson(res, 200, {endpointId, unsupported: redactSecrets(provider.forEndpoint(endpointId))});
            return;
        }
        const settingsRoute = /^\/(devices|groups|bridges)\/([^/]+)(\/settings)?$/.exec(pathname);
        if (settingsRoute && ((req.method === "GET" && settingsRoute[3]) || (req.method === "PATCH" && !settingsRoute[3]))) {
            const kind = settingsRoute[1] as SettingsKind;
            const id = decodeId(settingsRoute[2] ?? "", "resource id");
            if (req.method === "GET") this.readSettings(res, kind, id);
            else await this.patchSettings(req, res, kind, id, principal);
            return;
        }
        if (pathname === "/matter/commissioning") {
            const matter = this.deps.matterManagement;
            if (!matter) throw new ApiError("NOT_FOUND", "Matter management unavailable");
            if (req.method === "GET") {
                if (!matter.commissioningWindow) throw new ApiError("NOT_FOUND", "Commissioning unavailable");
                this.writeJson(res, 200, {window: redactSecrets(matter.commissioningWindow())});
                return;
            }
            if (req.method === "POST") {
                if (!matter.openCommissioningWindow) throw new ApiError("NOT_FOUND", "Commissioning unavailable");
                const body = await readJson(req, this.maxBodyBytes);
                this.writeJson(res, 201, redactSecrets(await matter.openCommissioningWindow(body)));
                return;
            }
            if (req.method === "DELETE") {
                if (!matter.closeCommissioningWindow) throw new ApiError("NOT_FOUND", "Commissioning unavailable");
                this.writeJson(res, 200, {closed: await matter.closeCommissioningWindow()});
                return;
            }
        }
        if (req.method === "GET" && pathname === "/matter/fabrics") {
            if (!this.deps.matterManagement?.listFabrics) throw new ApiError("NOT_FOUND", "Matter fabrics unavailable");
            this.writeJson(res, 200, {fabrics: redactSecrets(this.deps.matterManagement.listFabrics())});
            return;
        }
        if (req.method === "GET" && pathname === "/matter/endpoints") {
            if (!this.deps.matterManagement?.listEndpoints) throw new ApiError("NOT_FOUND", "Matter endpoints unavailable");
            this.writeJson(res, 200, {endpoints: redactSecrets(this.deps.matterManagement.listEndpoints())});
            return;
        }
        if (req.method === "GET" && pathname === "/tokens") {
            this.writeJson(res, 200, {tokens: this.deps.auth.list().map((token) => redactSecrets(token))});
            return;
        }
        if (req.method === "POST" && pathname === "/tokens") {
            const body = await readJson(req, this.maxBodyBytes);
            if (!isRecord(body) || !isScope(body.scope)) throw new ApiError("INVALID_ARGUMENT", "scope is required");
            if (body.label !== undefined && typeof body.label !== "string") throw new ApiError("INVALID_ARGUMENT", "label must be a string");
            if (body.ttlMs !== undefined && typeof body.ttlMs !== "number") throw new ApiError("INVALID_ARGUMENT", "ttlMs must be a number");
            const issued = this.deps.auth.issue(body.scope, {
                ...(body.label !== undefined ? {label: body.label} : {}),
                ...(body.ttlMs !== undefined ? {ttlMs: body.ttlMs} : {}),
            });
            this.writeJson(res, 201, issued);
            return;
        }
        if (req.method === "DELETE" && pathname.startsWith("/tokens/")) {
            const id = decodeTokenId(pathname.slice("/tokens/".length));
            this.deps.auth.revoke(id);
            this.writeJson(res, 200, {revoked: true});
            return;
        }
        if (req.method === "POST" && pathname === "/commands") {
            if (!this.deps.executeCommand) throw new ApiError("UNSUPPORTED", "Commands unavailable");
            const body = await readJson(req, this.maxBodyBytes);
            this.writeJson(res, 202, redactSecrets(await this.deps.executeCommand(body, principal)));
            return;
        }
        // admin 권한(requiredScope 기본값). passphrase는 응답/로그에 포함하지 않는다.
        if (req.method === "POST" && (pathname === "/backup" || pathname === "/backup/restore")) {
            const backup = this.deps.backup;
            if (!backup) throw new ApiError("NOT_FOUND", "Backup unavailable");
            const body = await readJson(req, this.maxBodyBytes);
            if (!isRecord(body) || typeof body.passphrase !== "string") throw new ApiError("INVALID_ARGUMENT", "passphrase is required");
            const restoring = pathname === "/backup/restore";
            try {
                if (restoring) await backup.restore(body.passphrase);
                else await backup.create(body.passphrase);
            } catch (error) {
                throw backupApiError(error);
            }
            if (restoring) this.writeJson(res, 200, {restored: true, restartRequired: true});
            else this.writeJson(res, 201, {created: true});
            return;
        }
        if (req.method === "POST" && pathname === "/migration") {
            if (!this.deps.runMigration) throw new ApiError("NOT_FOUND", "Migration unavailable");
            const body = await readJson(req, this.maxBodyBytes);
            this.writeJson(res, 202, redactSecrets(await this.deps.runMigration(body, principal)));
            return;
        }

        throw new ApiError("NOT_FOUND", "Not found");
    }

    private currentSettings(kind: SettingsKind, id: string): unknown {
        if (!this.deps.settings) throw new ApiError("UNSUPPORTED", "Settings API unavailable");
        const settings = this.deps.settings.read(kind, id);
        if (settings === undefined) throw new ApiError("NOT_FOUND", "Resource not found");
        return settings;
    }

    private readSettings(res: ServerResponse, kind: SettingsKind, id: string): void {
        const settings = this.currentSettings(kind, id);
        const revision = settingsRevision(settings);
        res.setHeader("ETag", `"${revision}"`);
        this.writeJson(res, 200, {id, revision, settings: redactSecrets(settings)});
    }

    /** C7 PATCH: 권한(admin, requiredScope 기본값) -> revision 검사(If-Match 또는 body.revision) -> CommandRouter 위임. */
    private async patchSettings(req: IncomingMessage, res: ServerResponse, kind: SettingsKind, id: string, principal: Principal): Promise<void> {
        if (!this.deps.executeCommand) throw new ApiError("UNSUPPORTED", "Commands unavailable");
        const body = await readJson(req, this.maxBodyBytes);
        if (!isRecord(body) || !isRecord(body.options)) throw new ApiError("INVALID_ARGUMENT", "options object is required");
        const expected = ifMatchRevision(req.headers["if-match"]) ?? (typeof body.revision === "string" ? body.revision : undefined);
        if (expected === undefined) throw new ApiError("INVALID_ARGUMENT", "revision (If-Match or body.revision) is required");
        const lockKey = `${kind}/${id}`;
        if (this.patching.has(lockKey)) throw new ApiError("CONFLICT", "Another settings change is in progress");
        this.patching.add(lockKey);
        try {
            const current = settingsRevision(this.currentSettings(kind, id));
            if (current !== expected) throw new ApiError("CONFLICT", "Revision mismatch");
            const request = kind === "devices" ? "device/options" : kind === "groups" ? "group/options" : "options";
            const value = kind === "bridges" ? {options: body.options} : {id, options: body.options};
            const result = await this.deps.executeCommand(
                {
                    requestId: randomUUID(),
                    correlationId: typeof body.correlationId === "string" ? body.correlationId : randomUUID(),
                    deadline: Date.now() + 30_000,
                    operation: "request",
                    target: {request},
                    value,
                },
                principal,
            );
            this.writeJson(res, 202, {previousRevision: current, result: redactSecrets(result)});
        } finally {
            this.patching.delete(lockKey);
        }
    }

    private writeJson(res: ServerResponse, status: number, value: unknown): void {
        const body = JSON.stringify(value);
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
    }

    private writeError(res: ServerResponse, error: ApiError): void {
        this.writeJson(res, error.httpStatus, error.toBody());
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is Scope {
    return value === "read" || value === "control" || value === "admin";
}

function decodeId(value: string, what: string): string {
    if (!value || value.includes("/")) throw new ApiError("INVALID_ARGUMENT", `Invalid ${what}`);
    try {
        const id = decodeURIComponent(value);
        if (!id || id.includes("/")) throw new ApiError("INVALID_ARGUMENT", `Invalid ${what}`);
        return id;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("INVALID_ARGUMENT", `Invalid ${what}`);
    }
}

function decodeTokenId(value: string): string {
    return decodeId(value, "token id");
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
}

/** 설정 revision = 현재 설정의 정규화 JSON sha256 앞 16자(hex). */
function settingsRevision(settings: unknown): string {
    return createHash("sha256").update(stableStringify(settings), "utf8").digest("hex").slice(0, 16);
}

function ifMatchRevision(header: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined) return undefined;
    return /^\s*(?:W\/)?"?([^"\s]+)"?\s*$/.exec(raw)?.[1];
}

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let size = 0;
        let settled = false;
        const chunks: Buffer[] = [];
        const fail = (error: ApiError): void => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        req.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
                fail(new ApiError("INVALID_ARGUMENT", "Request body is too large"));
                req.destroy();
                return;
            }
            chunks.push(buffer);
        });
        req.on("end", () => {
            if (settled) return;
            settled = true;
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve(body.length === 0 ? {} : JSON.parse(body));
            } catch {
                reject(new ApiError("INVALID_ARGUMENT", "Invalid JSON body"));
            }
        });
        req.on("aborted", () => fail(new ApiError("INVALID_ARGUMENT", "Request body was aborted")));
        req.on("error", () => fail(new ApiError("INVALID_ARGUMENT", "Request body could not be read")));
    });
}

/** 백업 오류를 C6 코드로 매핑한다. 잘못된 passphrase/손상은 INVALID_ARGUMENT, 그 외 내부 메시지(경로 등)는 노출하지 않는다. */
function backupApiError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof BackupInputError) return new ApiError("INVALID_ARGUMENT", error.message);
    const message = error instanceof Error ? error.message : "";
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return new ApiError("NOT_FOUND", "Backup not found");
    if (message === "backup or restore is already running") return new ApiError("CONFLICT", "Backup or restore is already running");
    if (message === "backup: lock timeout") return new ApiError("BUSY", "Backup is busy");

    return new ApiError("INTERNAL", "Backup operation failed");
}
