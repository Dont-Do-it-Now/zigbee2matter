/** C7 REST 라우팅 경계(T056). 기존 frontend HTTP 서버에 주입할 수 있는 Node handler. */
import type {IncomingMessage, ServerResponse} from "node:http";
import {authorizeRequest, type ApiAuth, type Principal, ApiError, redactSecrets, toApiError} from "./auth";
import {AuthFailureRateLimiter} from "./rateLimit";

export interface RestDevice {
    readonly id: string;
    readonly name?: string;
    readonly available: boolean;
    readonly entities?: readonly unknown[];
}

export interface RestRouterDeps {
    readonly auth: ApiAuth;
    readonly listDevices: () => readonly RestDevice[];
    readonly listGroups?: () => readonly unknown[];
    readonly listJobs?: () => readonly unknown[];
    readonly listBridges?: () => readonly unknown[];
    readonly listDiagnostics?: () => unknown;
    readonly executeCommand?: (input: unknown, principal: Principal) => Promise<unknown>;
    readonly origin?: {allowedOrigins?: readonly string[]; allowSameHost?: boolean};
    readonly maxBodyBytes?: number;
    readonly authFailureRateLimiter?: AuthFailureRateLimiter;
}

export class RestApiRouter {
    private readonly maxBodyBytes: number;

    constructor(private readonly deps: RestRouterDeps) {
        this.maxBodyBytes = Math.max(1024, Math.floor(deps.maxBodyBytes ?? 1_048_576));
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
        if (req.method === "POST" && pathname === "/commands") {
            if (!this.deps.executeCommand) throw new ApiError("UNSUPPORTED", "Commands unavailable");
            const body = await readJson(req, this.maxBodyBytes);
            this.writeJson(res, 202, redactSecrets(await this.deps.executeCommand(body, principal)));
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
