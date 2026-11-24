import type {BridgeBus} from "../bridgeBus/types";
import type EventBus from "../eventBus";
import type CommandLoopGuard from "./loopGuard";
import {
    BRIDGE_RESPONSE_PREFIX,
    buildBridgeRequestTopic,
    buildEntityTopic,
    classifyBridgeError,
    entityStateTopic,
    isIdempotent,
    isValidEntityName,
    KNOWN_BRIDGE_REQUESTS,
    sanitizeErrorMessage,
} from "./mapping";
import type {
    Command,
    CommandAuthorizer,
    CommandErrorCode,
    CommandHooks,
    CommandResult,
    CommandStatus,
    EntityCommand,
    TargetResolver,
    ValueValidator,
} from "./types";

const MAX_VALUE_KEYS = 64;
const MAX_VALUE_BYTES = 8192;
const TRANSACTION_PREFIX = "c3:";

export interface CommandRouterDeps {
    eventBus: EventBus;
    bridgeBus: BridgeBus;
    resolver: TargetResolver;
    authorizer: CommandAuthorizer;
    validator?: ValueValidator;
    loopGuard?: CommandLoopGuard;
    hooks?: CommandHooks;
    /** Test seam. */
    now?: () => number;
}

interface Pending {
    command: Command;
    resolve: (result: CommandResult) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    dispatched: boolean;
    /** `request`: transaction echoed by upstream `utils.getResponse`. */
    transaction?: string;
    /** `set`/`get`: canonical state topic and the keys whose appearance counts as an observation. */
    stateTopic?: string;
    keys?: ReadonlyArray<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adapter router: C3 `Command` -> existing upstream topic/payload injected through `BridgeBus.onMessage`
 * (-> `eventBus.bridgeBusMessage` -> `ExtensionPublish` / `ExtensionBridge`), and upstream observations
 * (`bridge/response/*` with `transaction`, entity state publish) -> C3 `CommandResult`.
 *
 * Upstream facts (docs/evidence/T012.md): `<name>/set|get` has NO response/error channel (errors are only logged,
 * `publish.ts` catch); only `bridge/request/*` echoes `transaction` with `status: ok|error`. Therefore:
 * - `request`: ok -> `executed`, error -> `failed`, silence until deadline -> `timeout`.
 * - `set`: first state publish containing a requested key -> `executed` (optimistic state, NOT device report);
 *   no publish until deadline -> `unknown` (converter failure / `optimistic:false` are indistinguishable).
 * - `get`: first state publish containing a requested key -> `confirmed` (device report); otherwise `unknown`.
 * `accepted` only means validated and handed to the bus; it never implies device success.
 */
export default class CommandRouter {
    private readonly pending = new Map<string, Pending>();
    private started = false;
    private readonly now: () => number;

    constructor(private readonly deps: CommandRouterDeps) {
        this.now = deps.now ?? ((): number => Date.now());
    }

    start(): void {
        if (!this.started) {
            this.started = true;
            this.deps.eventBus.onBridgeBusMessagePublished(this, this.onPublished);
        }
    }

    stop(): void {
        this.deps.eventBus.removeListeners(this);
        this.started = false;

        for (const requestId of [...this.pending.keys()]) {
            this.settle(requestId, "unknown", {errorCode: "UNAVAILABLE", errorMessage: "router stopped"});
        }
    }

    /** Resolves with the FINAL result. Intermediate statuses (`accepted`) go to `hooks.onResult`. Never rejects. */
    submit(command: Command): Promise<CommandResult> {
        const rejection = this.validate(command);

        if (rejection) {
            return Promise.resolve(this.emit(this.build(command, rejection.status ?? "failed", {...rejection, terminal: true, dispatched: false})));
        }

        this.deps.loopGuard?.record(command);

        const duplicate = this.deps.hooks?.admit?.(command);

        if (duplicate) {
            return Promise.resolve(this.emit(duplicate));
        }

        return new Promise<CommandResult>((resolve) => {
            const pending = this.register(command, resolve);
            this.emit(this.build(command, "accepted", {terminal: false, dispatched: false}));

            const run = (): void => this.inject(pending);
            const schedule = this.deps.hooks?.schedule;

            if (schedule) {
                if (schedule(command, run) === false) {
                    this.settle(command.requestId, "failed", {errorCode: "BUSY", errorMessage: "command queue is full"});
                }
            } else {
                run();
            }
        });
    }

    private validate(command: Command): ({errorCode: CommandErrorCode; errorMessage: string} & {status?: CommandStatus}) | undefined {
        const fail = (errorCode: CommandErrorCode, errorMessage: string, status?: CommandStatus) => ({errorCode, errorMessage, status});

        if (!command.requestId || !command.correlationId) {
            return fail("INVALID_ARGUMENT", "requestId and correlationId are required");
        }

        if (this.pending.has(command.requestId)) {
            return fail("CONFLICT", "requestId already in flight");
        }

        if (!command.identity?.principal) {
            return fail("UNAUTHORIZED", "no authenticated identity");
        }

        if (!Number.isFinite(command.deadline) || command.deadline <= this.now()) {
            return fail("TIMEOUT", "deadline already passed", "timeout");
        }

        if (!isPlainObject(command.value)) {
            return fail("INVALID_ARGUMENT", "value must be an object");
        }

        const keys = Object.keys(command.value);

        if (keys.length > MAX_VALUE_KEYS || (command.operation === "set" && keys.length === 0)) {
            return fail("INVALID_ARGUMENT", "value has invalid number of keys");
        }

        let serialized: string;

        try {
            serialized = JSON.stringify(command.value);
        } catch {
            return fail("INVALID_ARGUMENT", "value is not serializable");
        }

        if (serialized.length > MAX_VALUE_BYTES) {
            return fail("INVALID_ARGUMENT", "value too large");
        }

        if (command.operation === "request") {
            return this.validateRequest(command, keys, fail);
        }

        return this.validateEntity(command, fail);
    }

    private validateRequest(
        command: Extract<Command, {operation: "request"}>,
        keys: string[],
        fail: (code: CommandErrorCode, message: string) => {errorCode: CommandErrorCode; errorMessage: string; status?: CommandStatus},
    ): ReturnType<typeof fail> | undefined {
        if (keys.includes("transaction")) {
            return fail("INVALID_ARGUMENT", "'transaction' is reserved");
        }

        const auth = this.deps.authorizer.authorize(command, undefined);

        if (!auth.ok) {
            return fail(auth.errorCode, auth.message);
        }

        // Upstream silently ignores unknown request keys (no response), so reject before injecting.
        if (!KNOWN_BRIDGE_REQUESTS.has(command.target.request)) {
            return fail("UNSUPPORTED", "unknown bridge request");
        }

        return undefined;
    }

    private validateEntity(
        command: EntityCommand,
        fail: (code: CommandErrorCode, message: string) => {errorCode: CommandErrorCode; errorMessage: string; status?: CommandStatus},
    ): ReturnType<typeof fail> | undefined {
        if (command.operation !== "set" && command.operation !== "get") {
            return fail("INVALID_ARGUMENT", "unknown operation");
        }

        if (!isValidEntityName(command.target)) {
            return fail("INVALID_ARGUMENT", "invalid target");
        }

        const resolved = this.deps.resolver.resolve(command.target);
        const auth = this.deps.authorizer.authorize(command, resolved);

        // Authorize before revealing existence (NOT_FOUND) to unauthorized callers.
        if (!auth.ok) {
            return fail(auth.errorCode, auth.message);
        }

        if (!resolved.ok) {
            return fail(resolved.errorCode, resolved.message);
        }

        if (!resolved.supported) {
            return fail("UNSUPPORTED", "target has no definition");
        }

        const endpoint = command.target.endpoint;

        if (endpoint !== undefined) {
            if (resolved.kind === "group") {
                return fail("INVALID_ARGUMENT", "groups have no endpoint");
            }

            if (!resolved.endpointNames.includes(endpoint) && !/^\d+$/.test(endpoint)) {
                return fail("NOT_FOUND", "endpoint not found");
            }
        }

        const rejection = this.deps.validator?.validate(command, resolved);

        return rejection ? fail(rejection.errorCode, rejection.message) : undefined;
    }

    private register(command: Command, resolve: (result: CommandResult) => void): Pending {
        const pending: Pending = {command, resolve, timer: undefined, dispatched: false};

        if (command.operation === "request") {
            pending.transaction = `${TRANSACTION_PREFIX}${command.requestId}`;
        } else {
            // validate() guarantees a resolved target; re-resolve is cheap and pure (name may be an IEEE string).
            const resolved = this.deps.resolver.resolve(command.target);
            const name = resolved.ok ? resolved.name : command.target.entity;
            pending.stateTopic = entityStateTopic(name);
            const suffix = command.target.endpoint;
            pending.keys = Object.keys(command.value).flatMap((key) => (suffix === undefined ? [key] : [key, `${key}_${suffix}`]));
        }

        pending.timer = setTimeout(() => this.onDeadline(command.requestId), Math.max(0, command.deadline - this.now()));
        this.pending.set(command.requestId, pending);

        return pending;
    }

    private inject(pending: Pending): void {
        const {command} = pending;

        if (!this.pending.has(command.requestId)) {
            return; // settled (deadline/stop) while queued by the schedule hook: 0 RF.
        }

        try {
            pending.dispatched = true;

            if (command.operation === "request") {
                const payload = JSON.stringify({...command.value, transaction: pending.transaction});
                this.deps.bridgeBus.onMessage(buildBridgeRequestTopic(command.target.request), payload);
            } else {
                const resolved = this.deps.resolver.resolve(command.target);
                const name = resolved.ok ? resolved.name : command.target.entity;
                this.deps.bridgeBus.onMessage(buildEntityTopic(name, command.target.endpoint, command.operation), JSON.stringify(command.value));
            }
        } catch {
            this.settle(command.requestId, "failed", {errorCode: "INTERNAL", errorMessage: "dispatch failed"});
        }
    }

    private readonly onPublished = (data: eventdata.BridgeBusMessagePublished): void => {
        if (this.pending.size === 0) {
            return;
        }

        if (data.topic.startsWith(BRIDGE_RESPONSE_PREFIX)) {
            this.onBridgeResponse(data.payload);
            return;
        }

        for (const [requestId, pending] of this.pending) {
            if (pending.stateTopic === data.topic && pending.dispatched && this.reportMatches(pending, data.payload)) {
                // set: optimistic state (converter resolved) -> executed. get: device report -> confirmed.
                this.settle(requestId, pending.command.operation === "get" ? "confirmed" : "executed", {});
            }
        }
    };

    private reportMatches(pending: Pending, payload: string): boolean {
        try {
            const parsed: unknown = JSON.parse(payload);

            return isPlainObject(parsed) && (pending.keys ?? []).some((key) => key in parsed);
        } catch {
            return false;
        }
    }

    private onBridgeResponse(payload: string): void {
        let parsed: unknown;

        try {
            parsed = JSON.parse(payload);
        } catch {
            return;
        }

        if (!isPlainObject(parsed) || typeof parsed.transaction !== "string" || !parsed.transaction.startsWith(TRANSACTION_PREFIX)) {
            return;
        }

        const requestId = parsed.transaction.substring(TRANSACTION_PREFIX.length);
        const pending = this.pending.get(requestId);

        if (!pending || pending.transaction !== parsed.transaction) {
            return;
        }

        if (parsed.status === "ok") {
            this.settle(requestId, "executed", {data: parsed.data});
        } else {
            const raw = typeof parsed.error === "string" ? parsed.error : "request failed";
            this.settle(requestId, "failed", {errorCode: classifyBridgeError(raw), errorMessage: sanitizeErrorMessage(raw)});
        }
    }

    private onDeadline(requestId: string): void {
        const pending = this.pending.get(requestId);

        if (!pending) {
            return;
        }

        // Late reports after this point are NOT applied (C6): the result stays timeout/unknown.
        if (!pending.dispatched) {
            this.settle(requestId, "timeout", {errorCode: "TIMEOUT", errorMessage: "deadline passed before dispatch"});
        } else if (pending.command.operation === "request") {
            this.settle(requestId, "timeout", {errorCode: "TIMEOUT", errorMessage: "no response before deadline"});
        } else {
            this.settle(requestId, "unknown", {errorCode: "TIMEOUT", errorMessage: "no device report before deadline"});
        }
    }

    private settle(requestId: string, status: CommandStatus, extra: Partial<CommandResult>): void {
        const pending = this.pending.get(requestId);

        if (!pending) {
            return;
        }

        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(this.emit(this.build(pending.command, status, {...extra, terminal: true, dispatched: pending.dispatched})));
    }

    private build(command: Command, status: CommandStatus, extra: Partial<CommandResult> & {terminal: boolean; dispatched: boolean}): CommandResult {
        const autoRetryAllowed = isIdempotent(command);
        const failed = status === "failed" || status === "timeout" || status === "unknown";

        return {
            requestId: command.requestId,
            correlationId: command.correlationId,
            status,
            errorCode: extra.errorCode,
            errorMessage: extra.errorMessage,
            terminal: extra.terminal,
            dispatched: extra.dispatched,
            // Retry by the caller is only reasonable for transient codes; auto retry additionally needs idempotency (C3).
            retryable: failed && (extra.errorCode === "TIMEOUT" || extra.errorCode === "UNAVAILABLE" || extra.errorCode === "BUSY"),
            autoRetryAllowed,
            at: this.now(),
            data: extra.data,
        };
    }

    private emit(result: CommandResult): CommandResult {
        this.deps.hooks?.onResult?.(result);

        return result;
    }
}
