/** C7 REST 라우팅 경계(T056). 기존 frontend HTTP 서버에 주입할 수 있는 Node handler. */
import type {IncomingMessage, ServerResponse} from "node:http";
import {authorizeRequest, type ApiAuth, type Principal, type Scope, ApiError, redactSecrets, toApiError} from "./auth";
import {AuthFailureRateLimiter} from "./rateLimit";

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

export interface RestRouterDeps {
    readonly auth: ApiAuth;
    readonly listDevices: () => readonly RestDevice[];
    readonly listGroups?: () => readonly unknown[];
    readonly listJobs?: () => readonly unknown[];
    readonly listBridges?: () => readonly unknown[];
    readonly listDiagnostics?: () => unknown;
    readonly executeCommand?: (input: unknown, principal: Principal) => Promise<unknown>;
    readonly runMigration?: (input: unknown, principal: Principal) => Promise<unknown>;
    readonly matterManagement?: {
        readonly commissioningWindow?: () => unknown;
        readonly openCommissioningWindow?: (input: unknown) => unknown;
        readonly closeCommissioningWindow?: () => boolean;
        readonly listFabrics?: () => readonly unknown[];
        readonly listEndpoints?: () => readonly unknown[];
    };
    readonly origin?: {allowedOrigins?: readonly string[]; allowSameHost?: boolean};
    readonly maxBodyBytes?: number;
    readonly authFailureRateLimiter?: AuthFailureRateLimiter;
}

export class RestApiRouter {
    private readonly maxBodyBytes: number;

    constructor(private readonly deps: RestRouterDeps) {
        const maxBodyBytes = deps.maxBodyBytes ?? 1_048_576;
        if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new Error("maxBodyBytes must be an integer of at least 1024");
        this.maxBodyBytes = maxBodyBytes;
    }

    handle(req: IncomingMessage, res: ServerResponse): void {
        void this.dispatch(req, res).catch((error: unknown) => this.writeError(res, toApiError(error)));
    }

    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const prefix = "/api/v1";
        if (!url.pathname.startsWith(prefix)) {
            this.writeError(res, new ApiError("NOT_FOUND", "Not found"));
            return;
        }

        const pathname = url.pathname.slice(prefix.length) || "/";
        const clientKey = req.socket.remoteAddress ?? "unknown";
        if (this.deps.authFailureRateLimiter && !this.deps.authFailureRateLimiter.allow(clientKey)) {
            throw new ApiError("BUSY", "Too many authentication failures");
        }
        let principal: Principal;
        try {
            principal = authorizeRequest(this.deps.auth, {method: req.method ?? "GET", headers: req.headers, url: req.url}, pathname, {
                origin: this.deps.origin,
            });
            this.deps.authFailureRateLimiter?.reset(clientKey);
        } catch (error) {
            const apiError = toApiError(error);
            if (apiError.code === "UNAUTHORIZED") this.deps.authFailureRateLimiter?.recordFailure(clientKey);
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
                this.writeJson(res, 201, redactSecrets(matter.openCommissioningWindow(body)));
                return;
            }
            if (req.method === "DELETE") {
                if (!matter.closeCommissioningWindow) throw new ApiError("NOT_FOUND", "Commissioning unavailable");
                this.writeJson(res, 200, {closed: matter.closeCommissioningWindow()});
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
        if (req.method === "POST" && pathname === "/migration") {
            if (!this.deps.runMigration) throw new ApiError("NOT_FOUND", "Migration unavailable");
            const body = await readJson(req, this.maxBodyBytes);
            this.writeJson(res, 202, redactSecrets(await this.deps.runMigration(body, principal)));
            return;
        }

        throw new ApiError("NOT_FOUND", "Not found");
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

function decodeTokenId(value: string): string {
    if (!value || value.includes("/")) throw new ApiError("INVALID_ARGUMENT", "Invalid token id");
    try {
        const id = decodeURIComponent(value);
        if (!id || id.includes("/")) throw new ApiError("INVALID_ARGUMENT", "Invalid token id");
        return id;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("INVALID_ARGUMENT", "Invalid token id");
    }
}

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
                reject(new ApiError("INVALID_ARGUMENT", "Request body is too large"));
                req.destroy();
                return;
            }
            chunks.push(buffer);
        });
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve(body.length === 0 ? {} : JSON.parse(body));
            } catch {
                reject(new ApiError("INVALID_ARGUMENT", "Invalid JSON body"));
            }
        });
        req.on("error", () => reject(new ApiError("INVALID_ARGUMENT", "Request body could not be read")));
    });
}
