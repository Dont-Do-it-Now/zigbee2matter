/**
 * Command router contracts (T012, CONTRACTS C3/C5/C6). No Matter/HTTP import (C5): adapters build `Command` and call the router.
 *
 * `target` accepts the existing upstream entity interface (friendly name or IEEE string) or a stable T019 entity key.
 * A `TargetResolver` converts either form into the canonical upstream name and endpoint.
 */

export type CommandSource = "matter" | "http" | "ws" | "internal";

/** C6 error codes. */
export type CommandErrorCode =
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

/** C3 result statuses. `accepted` is NOT device success. */
export type CommandStatus = "accepted" | "executed" | "confirmed" | "failed" | "timeout" | "unknown";

/** Identity derived from an authenticated session by the adapter (never from the payload). */
export interface CommandIdentity {
    /** Opaque principal id (user/fabric node). */
    principal: string;
    fabricIndex?: number;
    sessionId?: string;
    /** Adapter-derived authorization scope; never read from the request body. */
    scope?: "read" | "control" | "admin";
}

/** Device/group target: friendly name or IEEE string as known to upstream (`Zigbee.resolveEntity`). */
export interface EntityTarget {
    entity?: string;
    /** Canonical `dev:`/`grp:` entity key. When supplied, endpoint comes from the key. */
    key?: string;
    /** Z2M endpoint label or numeric string (upstream `<name>/<endpoint>/set`). */
    endpoint?: string;
}

interface CommandBase {
    requestId: string;
    correlationId: string;
    source: CommandSource;
    identity: CommandIdentity;
    /** Absolute epoch ms. After this the router resolves `timeout`/`unknown`; late reports never rewrite the result (C6). */
    deadline: number;
    idempotencyKey?: string;
}

/** `<name>/set` (device/group command) or `<name>/get` (read). */
export interface EntityCommand extends CommandBase {
    operation: "set" | "get";
    target: EntityTarget;
    /** Upstream payload object, e.g. `{state: "ON", brightness: 100}`; for `get` key placeholders like `{state: ""}`. */
    value: Record<string, unknown>;
}

/** `bridge/request/<request>` (e.g. `permit_join`, `device/rename`). */
export interface BridgeRequestCommand extends CommandBase {
    operation: "request";
    target: {request: string};
    value: Record<string, unknown>;
}

export type Command = EntityCommand | BridgeRequestCommand;

export interface CommandResult {
    requestId: string;
    correlationId: string;
    status: CommandStatus;
    /** No further status change will be emitted for this request. */
    terminal: boolean;
    errorCode?: CommandErrorCode;
    /** Sanitized, truncated. Never contains keys/stack/tokens (C6). */
    errorMessage?: string;
    /** C6: whether the caller may retry at all (explicitly, by itself). */
    retryable: boolean;
    /** C3: false for toggle/lock/scene/relative moves; T015 must never auto retry when false. */
    autoRetryAllowed: boolean;
    /** True when RF/Zigbee may have been sent. False means guaranteed 0 RF (rejected before injection). */
    dispatched: boolean;
    /** Router-local observation time (epoch ms). */
    at: number;
    /** Upstream `bridge/response/*` `data`, only for `request`. */
    data?: unknown;
    /** C3 optional state revision. Not set by the router yet (needs C2 StateRecord / eventBus hook). */
    revision?: number;
}

export type ResolvedTarget =
    | {ok: true; name: string; kind: "device" | "group"; supported: boolean; endpointNames: ReadonlyArray<string>; endpoint?: string}
    | {ok: false; errorCode: "INVALID_ARGUMENT" | "NOT_FOUND" | "UNAVAILABLE"; message: string};

/** Port: entity lookup (adapter over `Zigbee.resolveEntity` and T019 keys). Must not send RF. */
export interface TargetResolver {
    resolve(target: EntityTarget): ResolvedTarget;
}

export type AuthDecision = {ok: true} | {ok: false; errorCode: "UNAUTHORIZED" | "FORBIDDEN"; message: string};

/** Port: authorization from the authenticated identity (C3: permission derived from session). `resolved` is undefined for bridge requests. */
export interface CommandAuthorizer {
    authorize(command: Command, resolved: ResolvedTarget | undefined): AuthDecision;
}

export interface ValueRejection {
    errorCode: "INVALID_ARGUMENT" | "FORBIDDEN" | "UNSUPPORTED";
    message: string;
}

/** Port (optional): value/feature access validation, e.g. from exposes (min/max/enum/access). Return undefined if OK. */
export interface ValueValidator {
    validate(command: EntityCommand, resolved: Extract<ResolvedTarget, {ok: true}>): ValueRejection | undefined;
}

/** Hook slots for T013 (queue), T014 (dedup), T015 (retry). Defaults are no-ops. */
export interface CommandHooks {
    /** T014: return a result to short-circuit (duplicate idempotencyKey). Return undefined to continue. */
    admit?(command: Command): CommandResult | undefined;
    /** T013: gate/serialize the actual injection. Default runs immediately. `run` must be called at most once. */
    /** Return false when the scheduler is saturated and the command must not be injected. */
    schedule?(command: Command, run: () => void): boolean | undefined;
    /** Every status change (also non-terminal). */
    onResult?(result: CommandResult): void;
}
