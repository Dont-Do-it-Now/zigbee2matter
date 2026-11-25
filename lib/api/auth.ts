// z2m-fork: T058 — /api/v1 REST·WS 인증/인가 (순수 모듈, HTTP 라우팅 연결은 T056/T057)
// 외부 의존성 없음(node:crypto만 사용). settings/logger를 import하지 않으며 설정은 호출자가 주입한다.
import {createHash, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";

/** 권한 범위. admin ⊃ control ⊃ read. */
export type Scope = "read" | "control" | "admin";
// Map 사용: 프로토타입 키("constructor", "__proto__" 등)가 유효 scope로 통과하지 않게 한다.
const SCOPE_RANK = new Map<string, number>([
    ["read", 1],
    ["control", 2],
    ["admin", 3],
]);
const isScope = (s: unknown): s is Scope => typeof s === "string" && SCOPE_RANK.has(s);
const HASH_RE = /^[0-9a-f]{64}$/;

/** C6 오류 코드 (docs/CONTRACTS.md). */
export type ApiErrorCode =
    | "INVALID_ARGUMENT"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "UNSUPPORTED"
    | "UNAVAILABLE"
    | "BUSY"
    | "TIMEOUT"
    | "CONFLICT"
    | "INTERNAL";

// HTTP status는 후보값(C7: P0 계약 승인 후 고정).
const HTTP_STATUS: Record<ApiErrorCode, number> = {
    INVALID_ARGUMENT: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    UNSUPPORTED: 501,
    UNAVAILABLE: 503,
    BUSY: 429,
    TIMEOUT: 504,
    CONFLICT: 409,
    INTERNAL: 500,
};
const RETRYABLE = new Set<ApiErrorCode>(["UNAVAILABLE", "BUSY", "TIMEOUT"]);

/** WS close code. 4401은 upstream frontend.ts와 동일. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

export interface ApiErrorBody {
    error: {code: ApiErrorCode; message: string; retryable: boolean};
}

/** 외부로 노출 가능한 오류. message에는 토큰/키/스택을 넣지 않는다. */
export class ApiError extends Error {
    constructor(
        public readonly code: ApiErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
    get httpStatus(): number {
        return HTTP_STATUS[this.code];
    }
    get retryable(): boolean {
        return RETRYABLE.has(this.code);
    }
    toBody(): ApiErrorBody {
        return {error: {code: this.code, message: this.message, retryable: this.retryable}};
    }
}

// 서비스 계층(ServiceUnavailableError 등)이 `code`로 알리는 C6 코드. 인증/인가 코드는 이 계층이 결정하므로 제외한다.
const SERVICE_ERROR_MESSAGES = new Map<string, string>([
    ["INVALID_ARGUMENT", "Invalid argument"],
    ["NOT_FOUND", "Not found"],
    ["UNSUPPORTED", "Unsupported"],
    ["UNAVAILABLE", "Service unavailable"],
    ["BUSY", "Busy"],
    ["TIMEOUT", "Timeout"],
    ["CONFLICT", "Conflict"],
]);

/** 예외를 비밀/스택 없이 변환. C6 `code`를 가진 서비스 오류는 그 코드로, 그 외는 INTERNAL. 원본 message는 노출하지 않는다. */
export function toApiError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    const code = err instanceof Error ? (err as {code?: unknown}).code : undefined;
    const message = typeof code === "string" ? SERVICE_ERROR_MESSAGES.get(code) : undefined;
    if (message !== undefined) return new ApiError(code as ApiErrorCode, message);
    return new ApiError("INTERNAL", "Internal error");
}

/** 인증된 세션 주체 (C3: 권한은 인증된 세션에서 도출). 토큰 원문/해시는 포함하지 않는다. */
export interface Principal {
    /** 토큰 id (로그/감사용 식별자, 비밀 아님). 레거시 토큰은 "legacy". */
    tokenId: string;
    scope: Scope;
    source: "token" | "legacy" | "anonymous";
}

export interface TokenRecord {
    id: string;
    /** sha256(secret) hex. 원문은 저장하지 않는다. */
    hash: string;
    scope: Scope;
    label?: string;
    /** epoch ms. 없으면 무기한. */
    expiresAt?: number;
    revokedAt?: number;
}

/** 공개 가능한 토큰 정보 (hash 제외). */
export type TokenInfo = Omit<TokenRecord, "hash">;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** 길이와 무관하게 상수시간 비교(양쪽을 sha256으로 정규화 후 timingSafeEqual). */
export function safeEqual(a: string, b: string): boolean {
    return timingSafeEqual(sha256(a), sha256(b));
}

export interface AuthOptions {
    /** upstream `frontend.auth_token`. 설정 시 admin 권한 토큰으로 인정(기존 UI 호환, Q1/O6). */
    legacyToken?: string;
    /** 무토큰 요청에 부여할 권한. 기본 undefined = 실패 시 닫힘(fail closed). */
    anonymousScope?: Scope;
    /** 발급/폐기 시 영속화 훅(저장소는 T056/T064 범위). 해시만 전달된다. */
    onChange?: (records: readonly TokenRecord[]) => void;
    /** 테스트용 시계 주입. */
    now?: () => number;
    /** 경고 출력 훅(불량 영속 레코드 폐기 등). 비밀은 전달되지 않는다. */
    warn?: (message: string) => void;
}

export class ApiAuth {
    private readonly records = new Map<string, TokenRecord>();
    private readonly now: () => number;

    constructor(
        private readonly options: AuthOptions = {},
        initial: readonly TokenRecord[] = [],
    ) {
        this.now = options.now ?? Date.now;
        for (const r of initial) {
            // 불량 레코드는 버리고 경고만(전체 기동 차단 금지). 해시/토큰 값은 경고에 포함하지 않는다.
            if (
                r &&
                typeof r.id === "string" &&
                r.id &&
                isScope(r.scope) &&
                typeof r.hash === "string" &&
                HASH_RE.test(r.hash) &&
                (r.label === undefined || typeof r.label === "string") &&
                (r.expiresAt === undefined || (Number.isSafeInteger(r.expiresAt) && r.expiresAt >= 0)) &&
                (r.revokedAt === undefined || (Number.isSafeInteger(r.revokedAt) && r.revokedAt >= 0))
            ) {
                this.records.set(r.id, {...r});
            } else {
                options.warn?.(`Discarded invalid API token record (id=${typeof r?.id === "string" ? r.id : "?"})`);
            }
        }
    }

    /** 새 토큰 발급. secret은 이 반환값으로만 한 번 노출된다. */
    issue(scope: Scope, opts: {label?: string; ttlMs?: number} = {}): {id: string; secret: string; info: TokenInfo} {
        if (!isScope(scope)) throw new ApiError("INVALID_ARGUMENT", "Invalid scope");
        if (opts.label !== undefined && typeof opts.label !== "string") {
            throw new ApiError("INVALID_ARGUMENT", "Invalid label");
        }
        if (opts.ttlMs !== undefined && !(Number.isSafeInteger(opts.ttlMs) && opts.ttlMs > 0 && Number.isSafeInteger(this.now() + opts.ttlMs))) {
            throw new ApiError("INVALID_ARGUMENT", "Invalid ttl");
        }
        const secret = randomBytes(32).toString("base64url");
        const id = randomUUID();
        const rec: TokenRecord = {
            id,
            hash: sha256(secret).toString("hex"),
            scope,
            label: opts.label,
            expiresAt: opts.ttlMs === undefined ? undefined : this.now() + opts.ttlMs,
        };
        this.records.set(id, rec);
        try {
            this.persist();
        } catch (error) {
            this.records.delete(id);
            throw error;
        }
        return {id, secret, info: toInfo(rec)};
    }

    /** 토큰 폐기. 이미 폐기됐거나 없으면 NOT_FOUND. */
    revoke(id: string): void {
        const rec = this.records.get(id);
        if (!rec || rec.revokedAt !== undefined) throw new ApiError("NOT_FOUND", "Token not found");
        rec.revokedAt = this.now();
        try {
            this.persist();
        } catch (error) {
            rec.revokedAt = undefined;
            throw error;
        }
    }

    list(): TokenInfo[] {
        return [...this.records.values()].map(toInfo);
    }

    /**
     * 토큰 원문 검증. 모든 레코드를 순회해 early-exit 타이밍 차이를 제거한다.
     * 실패 사유(없음/만료/폐기)는 외부에 구분해 노출하지 않는다.
     */
    verify(secret: string | undefined): Principal | undefined {
        if (!secret) return undefined;
        const digest = sha256(secret);
        let found: TokenRecord | undefined;
        for (const rec of this.records.values()) {
            const h = Buffer.from(rec.hash, "hex");
            if (h.length === digest.length && timingSafeEqual(digest, h)) found = rec;
        }
        const legacyOk = this.options.legacyToken ? safeEqual(secret, this.options.legacyToken) : false;
        if (found && found.revokedAt === undefined && (found.expiresAt === undefined || found.expiresAt > this.now())) {
            return {tokenId: found.id, scope: found.scope, source: "token"};
        }
        if (legacyOk) return {tokenId: "legacy", scope: "admin", source: "legacy"};
        return undefined;
    }

    /**
     * 요청 인증. 토큰이 없거나 잘못되면 UNAUTHORIZED.
     * anonymousScope가 설정된 경우에만 무토큰 요청을 허용(잘못된 토큰은 항상 거부).
     */
    authenticate(secret: string | undefined): Principal {
        // undefined = 자격 증명 없음. ""(형식 불량/빈 토큰)은 익명이 아니라 UNAUTHORIZED.
        if (secret === undefined) {
            if (this.options.anonymousScope) return {tokenId: "anonymous", scope: this.options.anonymousScope, source: "anonymous"};
            throw new ApiError("UNAUTHORIZED", "Authentication required");
        }
        const p = this.verify(secret);
        if (!p) throw new ApiError("UNAUTHORIZED", "Invalid or expired token");
        return p;
    }

    private persist(): void {
        this.options.onChange?.([...this.records.values()].map((r) => ({...r})));
    }
}

function toInfo(rec: TokenRecord): TokenInfo {
    const {hash: _hash, ...info} = rec;
    return {...info};
}

/** 권한 검사. 부족하면 FORBIDDEN. */
export function requireScope(principal: Principal, needed: Scope): void {
    const p = SCOPE_RANK.get(principal.scope);
    const n = SCOPE_RANK.get(needed);
    if (p === undefined || n === undefined || p < n) throw new ApiError("FORBIDDEN", "Insufficient scope");
}

/**
 * C7 기준 요청별 필요 권한(후보). pathname은 `/api/v1` 이후 경로(예: "/devices").
 * 조회(devices/groups/jobs/commands)=read, 명령/작업 생성=control,
 * 토큰·브리지·진단·설정 변경·알 수 없는 경로/메서드=admin(거부 방향 기본값).
 * 전제: 호출자가 라우터와 동일한 정규화된 경로를 넘긴다. 여기서는 `..`/`.`/빈 세그먼트/인코딩된 구분자(%2e,%2f,%5c)/역슬래시를
 * 포함한 경로를 INVALID_ARGUMENT로 거부해 권한 판정과 라우팅 해석의 불일치를 막는다.
 */
export function requiredScope(method: string, pathname: string): Scope {
    const m = method.toUpperCase();
    const rest = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    const segs = rest === "" ? [] : rest.split("/");
    if (/%2e|%2f|%5c|\\/i.test(pathname) || segs.some((s) => s === "" || s === "." || s === "..")) {
        throw new ApiError("INVALID_ARGUMENT", "Invalid path");
    }
    const seg = segs[0] ?? "";
    if (seg === "tokens" || seg === "bridges" || seg === "diagnostics") return "admin";
    if (m === "GET" || m === "HEAD") return ["devices", "groups", "jobs", "commands"].includes(seg) ? "read" : "admin";
    if (m === "POST" && (seg === "commands" || seg === "jobs")) return "control";
    return "admin";
}

export interface RequestLike {
    headers: Record<string, string | string[] | undefined>;
    /** 요청 URL (경로+쿼리). WS 쿼리 토큰 호환용. */
    url?: string;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * 토큰 추출. `Authorization: Bearer <token>` 우선.
 * allowQueryToken(WS 전용 권장)은 upstream `?token=` 호환이며 URL에 남아 로그/프록시에 노출될 수 있다.
 */
export function extractToken(req: RequestLike, opts: {allowQueryToken?: boolean} = {}): string | undefined {
    // 반환: undefined=자격 증명 없음, ""=제시됐으나 형식 불량/빈 값(인증 실패로 처리, 익명 부여 금지).
    const auth = first(req.headers.authorization);
    if (auth !== undefined) {
        const m = /^Bearer +(\S+)$/i.exec(auth);
        return m ? m[1] : "";
    }
    if (opts.allowQueryToken && req.url) {
        try {
            return new URL(req.url, "http://localhost").searchParams.get("token") ?? undefined;
        } catch {
            return "";
        }
    }
    return undefined;
}

export interface OriginPolicy {
    /** 허용 Origin 목록(정규화된 `scheme://host[:port]`). */
    allowedOrigins?: readonly string[];
    /**
     * true면 Origin의 host가 Host 헤더와 같을 때 허용(기본 true).
     * 주의: DNS rebinding 시 공격자 도메인의 Origin과 Host가 일치하므로 same-host는 방어가 되지 않는다.
     * `anonymousScope` 사용(무토큰 허용) 시에는 allowSameHost=false + allowedOrigins 명시를 권장.
     */
    allowSameHost?: boolean;
}

/**
 * CSRF/Cross-Site WebSocket Hijacking 방어. Origin 헤더가 없으면(비브라우저 클라이언트) 통과.
 * 브라우저가 보낸 Origin은 허용 목록 또는 same-host여야 한다. 위반 시 FORBIDDEN.
 */
export function checkOrigin(req: RequestLike, policy: OriginPolicy = {}): void {
    const origin = first(req.headers.origin);
    if (origin === undefined) return;
    let u: URL;
    try {
        u = new URL(origin);
    } catch {
        throw new ApiError("FORBIDDEN", "Origin not allowed");
    }
    if (policy.allowedOrigins?.includes(u.origin)) return;
    const host = first(req.headers.host);
    if ((policy.allowSameHost ?? true) && host && u.host.toLowerCase() === host.toLowerCase()) return;
    throw new ApiError("FORBIDDEN", "Origin not allowed");
}

/** REST: Origin 검사 → 토큰 추출 → 인증 → 권한 검사. 실패 시 ApiError throw. */
export function authorizeRequest(
    auth: ApiAuth,
    req: RequestLike & {method: string},
    pathname: string,
    opts: {allowQueryToken?: boolean; origin?: OriginPolicy} = {},
): Principal {
    try {
        checkOrigin(req, opts.origin);
        const principal = auth.authenticate(extractToken(req, opts));
        requireScope(principal, requiredScope(req.method, pathname));
        return principal;
    } catch (e) {
        throw toApiError(e);
    }
}

/** WS 연결용: Origin + 인증 + read 권한. 실패 시 닫을 close code/사유 반환(비밀 없음). */
export function authorizeWebSocket(
    auth: ApiAuth,
    req: RequestLike,
    opts: {origin?: OriginPolicy; allowQueryToken?: boolean} = {},
): {ok: true; principal: Principal} | {ok: false; closeCode: number; reason: string} {
    try {
        checkOrigin(req, opts.origin);
        const principal = auth.authenticate(extractToken(req, {allowQueryToken: opts.allowQueryToken ?? true}));
        requireScope(principal, "read");
        return {ok: true, principal};
    } catch (e) {
        const err = toApiError(e);
        return {ok: false, closeCode: err.code === "FORBIDDEN" ? WS_CLOSE_FORBIDDEN : WS_CLOSE_UNAUTHORIZED, reason: err.message};
    }
}

/** upstream settings.frontend 부분(필요 필드만). */
export interface FrontendAuthSettings {
    auth_token?: string | null;
    host?: string;
    ssl_cert?: string;
    ssl_key?: string;
}

/** settings.frontend에서 ApiAuth 옵션 생성. 레거시 auth_token 재사용. */
export function authOptionsFromFrontend(fe: FrontendAuthSettings): AuthOptions {
    return {legacyToken: fe.auth_token || undefined};
}

/**
 * 전송 경계 평가(파일 접근 없음). TLS 서버 생성은 upstream frontend.ts의 ssl_cert/ssl_key 처리를 재사용하며,
 * 여기서는 토큰이 평문으로 외부 노출되는 구성을 경고만 한다.
 */
export function assessTransport(fe: FrontendAuthSettings, opts: {trustedIngress?: boolean} = {}): {secure: boolean; warnings: string[]} {
    const tls = Boolean(fe.ssl_cert && fe.ssl_key);
    const local = fe.host !== undefined && (fe.host.startsWith("/") || fe.host === "127.0.0.1" || fe.host === "::1" || fe.host === "localhost");
    const secure = tls || local || Boolean(opts.trustedIngress);
    const warnings: string[] = [];
    if (!secure) {
        warnings.push(
            "API tokens would be sent in cleartext: enable ssl_cert/ssl_key, bind to loopback/unix socket, or place behind a trusted TLS ingress",
        );
    }
    return {secure, warnings};
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key|ssl_key|network_key|pan_id_key)/i;

/** 로그/응답용 깊은 복사: 비밀 키 값을 "[REDACTED]"로 대체. 순환 참조 안전. */
export function redactSecrets<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return "[Circular]" as unknown as T;
    seen.add(value as object);
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v, seen)) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redactSecrets(v, seen);
    }
    return out as T;
}

/** URL의 `token` 쿼리 값을 가려 로그에 남길 수 있게 한다. */
export function redactUrl(url: string): string {
    return url.replace(/([?&]token=)[^&#]*/gi, "$1[REDACTED]");
}
