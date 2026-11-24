import type {BridgeBus} from "../bridgeBus/types";
import type EventBus from "../eventBus";
import {
    BRIDGE_RESPONSE_PREFIX,
    buildBridgeRequestTopic,
    buildEntityTopic,
    classifyBridgeError,
    entityStateTopic,
    isExistenceOnlyKey,
    isIdempotent,
    isValidEntityName,
    KNOWN_BRIDGE_REQUESTS,
    SENSITIVE_BRIDGE_REQUESTS,
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
import type CommandLoopGuard from "./loopGuard";

const MAX_VALUE_KEYS = 64;
const MAX_VALUE_BYTES = 8192;
const MAX_DEADLINE_MS = 10 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const TRANSACTION_PREFIX = "c3:";

export interface CommandRouterDeps {
    eventBus: EventBus;
    bridgeBus: BridgeBus;
    resolver: TargetResolver;
    authorizer: CommandAuthorizer;
    validator?: ValueValidator;
    hooks?: CommandHooks;
    /** Sensitive bridge requests (see `SENSITIVE_BRIDGE_REQUESTS`) explicitly allowed. Default: none. */
    allowedSensitiveRequests?: ReadonlySet<string>;
    loopGuard?: CommandLoopGuard;
    /** Test seam. */
    now?: () => number;
}

interface Expectation {
    /** Accepted payload key names (`key`, `key_<endpoint>`). */
    names: ReadonlyArray<string>;
    /** Requested primitive value to compare (case-insensitive string compare). Ignored when `existsOnly`. */
    expected: unknown;
    existsOnly: boolean;
}

interface Pending {
    command: Command;
    resolve: (result: CommandResult) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    dispatched: boolean;
    /** Canonical entity name from the single `resolver.resolve` call in validate (entity commands). */
    name?: string;
    /** `request`: transaction echoed by upstream `utils.getResponse`. */
    transaction?: string;
    /** `set`/`get`: state topic and observation expectations. */
    stateTopic?: string;
    expectations?: ReadonlyArray<Expectation>;
}

interface Rejection {
    errorCode: CommandErrorCode;
    errorMessage: string;
    status?: CommandStatus;
}

interface Validation {
    rejection?: Rejection;
    name?: string;
}

function reject(errorCode: CommandErrorCode, errorMessage: string, status?: CommandStatus): Validation {
    return {rejection: {errorCode, errorMessage, status}};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesMatch(published: unknown, expected: unknown): boolean {
    if (typeof published === "object" || typeof expected === "object") {
        return false;
    }

    return String(published).toLowerCase() === String(expected).toLowerCase();
}

/**
 * Adapter router: C3 `Command` -> existing upstream topic/payload injected through `BridgeBus.onMessage`
 * (-> `eventBus.bridgeBusMessage` -> `ExtensionPublish` / `ExtensionBridge`), and upstream observations
 * (`bridge/response/*` with `transaction`, entity state publish) -> C3 `CommandResult`.
 *
 * Upstream facts (docs/evidence/T012.md): `<name>/set|get` has NO response/error channel (errors are only logged,
 * `publish.ts` catch); only `bridge/request/*` echoes `transaction` with `status: ok|error`. Therefore:
 * - `request`: ok -> `executed`, error -> `failed`, silence until deadline -> `timeout`.
 * - `set`/`get`: an entity-state publish (`meta.isEntityState`) matching the request -> `executed` (optimistic/cached state, NOT a
 *   device report; `confirmed` is never issued here); none until deadline -> `unknown`.
 * `accepted` only means validated and handed to the bus; it never implies device success. `submit` never throws/rejects.
 */
export default class CommandRouter {
    private readonly pending = new Map<string, Pending>();
    private running = false;
    private readonly now: () => number;

    constructor(private readonly deps: CommandRouterDeps) {
        this.now = deps.now ?? ((): number => Date.now());
    }

    start(): void {
        if (!this.running) {
            this.running = true;
            this.deps.eventBus.onBridgeBusMessagePublished(this, this.onPublished);
        }
    }

    stop(): void {
        this.running = false;
        this.deps.eventBus.removeListeners(this);

        for (const [requestId, pending] of [...this.pending]) {
            // Not yet injected (queued by the schedule hook): guaranteed 0 RF -> failed. Injected: outcome unknown.
            this.settle(requestId, pending.dispatched ? "unknown" : "failed", {errorCode: "UNAVAILABLE", errorMessage: "router stopped"});
        }
    }

    /** Resolves with the FINAL result. Intermediate statuses (`accepted`) go to `hooks.onResult`. Never throws, never rejects. */
    submit(command: Command): Promise<CommandResult> {
        if (!this.running) {
            return Promise.resolve(this.emit(this.build(command, "failed", {errorCode: "UNAVAILABLE", errorMessage: "router not running", terminal: true, dispatched: false})));
        }

        try {
            const validation = this.validate(command);

            if (validation.rejection) {
                return Promise.resolve(this.emit(this.build(command, validation.rejection.status ?? "failed", {...validation.rejection, terminal: true, dispatched: false})));
            }

            this.deps.loopGuard?.record(command);
            const duplicate = this.deps.hooks?.admit?.(command);

            if (duplicate) {
                return Promise.resolve(this.emit(duplicate));
            }

            return new Promise<CommandResult>((resolve) => {
                let registered: Pending | undefined;

                try {
                    registered = this.register(command, validation.name, resolve);
                    this.emit(this.build(command, "accepted", {terminal: false, dispatched: false}));

                    const pending = registered;
                    const run = (): void => this.inject(pending);
                    const schedule = this.deps.hooks?.schedule;

                    if (schedule) {
                        if (schedule(command, run) === false) {
                            this.settleNow(registered, "failed", {
                                errorCode: "BUSY",
                                errorMessage: "command queue is full",
                                terminal: true,
                            });
                        }
                    } else {
                        run();
                    }
                } catch {
                    // schedule/register threw synchronously: clean up timer/pending, report actual dispatch state.
                    if (registered && this.pending.get(command.requestId) === registered) {
                        this.settleNow(registered, "failed", {errorCode: "INTERNAL", errorMessage: "internal error", terminal: true});
                    } else {
                        resolve(this.emit(this.build(command, "failed", {errorCode: "INTERNAL", errorMessage: "internal error", terminal: true, dispatched: false})));
                    }
                }
            });
        } catch {
            return Promise.resolve(this.emit(this.build(command, "failed", {errorCode: "INTERNAL", errorMessage: "internal error", terminal: true, dispatched: false})));
        }
    }

    private validate(command: Command): Validation {
        if (!command?.requestId || !command.correlationId) {
            return reject("INVALID_ARGUMENT", "requestId and correlationId are required");
        }

        if (this.pending.has(command.requestId)) {
            return reject("CONFLICT", "requestId already in flight");
        }

        if (!command.identity?.principal) {
            return reject("UNAUTHORIZED", "no authenticated identity");
        }

        const remaining = command.deadline - this.now();

        if (!Number.isFinite(command.deadline) || remaining <= 0) {
            return reject("TIMEOUT", "deadline already passed", "timeout");
        }

        if (remaining > MAX_DEADLINE_MS) {
            return reject("INVALID_ARGUMENT", "deadline too far in the future");
        }

        if (!isPlainObject(command.value)) {
            return reject("INVALID_ARGUMENT", "value must be an object");
        }

        const keys = Object.keys(command.value);

        if (keys.length > MAX_VALUE_KEYS || (command.operation !== "request" && keys.length === 0)) {
            return reject("INVALID_ARGUMENT", "value has invalid number of keys");
        }

        let serialized: string;

        try {
            serialized = JSON.stringify(command.value);
        } catch {
            return reject("INVALID_ARGUMENT", "value is not serializable");
        }

        if (serialized.length > MAX_VALUE_BYTES) {
            return reject("INVALID_ARGUMENT", "value too large");
        }

        return command.operation === "request" ? this.validateRequest(command, keys) : this.validateEntity(command);
    }

    private validateRequest(command: Extract<Command, {operation: "request"}>, keys: string[]): Validation {
        if (keys.includes("transaction")) {
            return reject("INVALID_ARGUMENT", "'transaction' is reserved");
        }

        const auth = this.deps.authorizer.authorize(command, undefined);

        if (!auth.ok) {
            return reject(auth.errorCode, auth.message);
        }

        const request = command.target.request;

        // Upstream silently ignores unknown request keys (no response), so reject before injecting.
        if (!KNOWN_BRIDGE_REQUESTS.has(request)) {
            return reject("UNSUPPORTED", "unknown bridge request");
        }

        if (SENSITIVE_BRIDGE_REQUESTS.has(request) && !this.deps.allowedSensitiveRequests?.has(request)) {
            return reject("FORBIDDEN", "sensitive bridge request is disabled");
        }

        return {};
    }

    private validateEntity(command: EntityCommand): Validation {
        if (command.operation !== "set" && command.operation !== "get") {
            return reject("INVALID_ARGUMENT", "unknown operation");
        }

        if (!isValidEntityName(command.target)) {
            return reject("INVALID_ARGUMENT", "invalid target");
        }

        // The ONLY resolve call; its canonical name is reused for topic building and observation.
        const resolved = this.deps.resolver.resolve(command.target);
        const auth = this.deps.authorizer.authorize(command, resolved);

        // Authorize before revealing existence (NOT_FOUND) to unauthorized callers.
        if (!auth.ok) {
            return reject(auth.errorCode, auth.message);
        }

        if (!resolved.ok) {
            return reject(resolved.errorCode, resolved.message);
        }

        if (!resolved.supported) {
            return reject("UNSUPPORTED", "target has no definition");
        }

        const endpoint = command.target.endpoint;

        if (endpoint !== undefined) {
            if (resolved.kind === "group") {
                return reject("INVALID_ARGUMENT", "groups have no endpoint");
            }

            if (!resolved.endpointNames.includes(endpoint) && !/^\d+$/.test(endpoint)) {
                return reject("NOT_FOUND", "endpoint not found");
            }
        }

        const rejection = this.deps.validator?.validate(command, resolved);

        return rejection ? reject(rejection.errorCode, rejection.message) : {name: resolved.name};
    }

    private register(command: Command, name: string | undefined, resolve: (result: CommandResult) => void): Pending {
        const pending: Pending = {command, resolve, timer: undefined, dispatched: false};

        if (command.operation === "request") {
            pending.transaction = `${TRANSACTION_PREFIX}${command.requestId}`;
        } else if (name === undefined) {
            throw new Error("entity command without resolved name");
        } else {
            const suffix = command.target.endpoint;
            pending.name = name;
            pending.stateTopic = entityStateTopic(name);
            pending.expectations = Object.entries(command.value).map(([key, value]) => ({
                names: suffix === undefined ? [key] : [key, `${key}_${suffix}`],
                expected: value,
                // `get` values are placeholders; only presence of the key in the published state is meaningful.
                existsOnly: command.operation === "get" || isExistenceOnlyKey(key, value),
            }));
        }

        const timer = setTimeout(() => this.onDeadline(command.requestId), Math.min(MAX_TIMER_MS, Math.max(0, command.deadline - this.now())));
        timer.unref();
        pending.timer = timer;
        this.pending.set(command.requestId, pending);

        return pending;
    }

    private inject(pending: Pending): void {
        const {command} = pending;

        if (this.pending.get(command.requestId) !== pending) {
            return; // settled (deadline/stop) while queued by the schedule hook: 0 RF.
        }

        try {
            if (command.operation === "request") {
                const payload = JSON.stringify({...command.value, transaction: pending.transaction});
                pending.dispatched = true;
                this.deps.bridgeBus.onMessage(buildBridgeRequestTopic(command.target.request), payload);
            } else if (pending.name !== undefined) {
                const topic = buildEntityTopic(pending.name, command.target.endpoint, command.operation);
                pending.dispatched = true;
                this.deps.bridgeBus.onMessage(topic, JSON.stringify(command.value));
            }
        } catch {
            this.settleNow(pending, "failed", {errorCode: "INTERNAL", errorMessage: "dispatch failed", terminal: true});
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

        // Only entity state publishes (`Controller.publishEntityState` sets meta.isEntityState) are observations.
        if (data.options?.meta?.isEntityState !== true) {
            return;
        }

        for (const [requestId, pending] of [...this.pending]) {
            if (pending.stateTopic === data.topic && pending.dispatched && this.reportMatches(pending, data.payload)) {
                // Optimistic (set) or cached/reported (get) state: cannot be told apart from a device report here -> `executed`, never `confirmed`.
                this.settle(requestId, "executed", {});
            }
        }
    };

    private reportMatches(pending: Pending, payload: string): boolean {
        let parsed: unknown;

        try {
            parsed = JSON.parse(payload);
        } catch {
            return false;
        }

        if (!isPlainObject(parsed)) {
            return false;
        }

        const state = parsed;

        return (pending.expectations ?? []).some((e) =>
            e.names.some((name) => name in state && (e.existsOnly || valuesMatch(state[name], e.expected))),
        );
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
            this.settle(requestId, "unknown", {errorCode: "TIMEOUT", errorMessage: "no state report before deadline"});
        }
    }

    private settle(requestId: string, status: CommandStatus, extra: Partial<CommandResult>): void {
        const pending = this.pending.get(requestId);

        if (pending) {
            this.settleNow(pending, status, {...extra, terminal: true});
        }
    }

    private settleNow(pending: Pending, status: CommandStatus, extra: Partial<CommandResult> & {terminal: boolean}): CommandResult {
        this.pending.delete(pending.command.requestId);
        clearTimeout(pending.timer);

        // `emit` swallows hook errors, so `resolve` is always reached.
        const result = this.emit(this.build(pending.command, status, {...extra, dispatched: pending.dispatched}));
        pending.resolve(result);

        return result;
    }

    private build(command: Command, status: CommandStatus, extra: Partial<CommandResult> & {terminal: boolean; dispatched: boolean}): CommandResult {
        const failed = status === "failed" || status === "timeout" || status === "unknown";
        let autoRetryAllowed = false;

        try {
            autoRetryAllowed = isIdempotent(command);
        } catch {
            // malformed command: keep the safe default (no auto retry)
        }

        return {
            requestId: String(command?.requestId ?? ""),
            correlationId: String(command?.correlationId ?? ""),
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
            revision: extra.revision,
        };
    }

    /** Hook errors must never break resolution: swallowed. */
    private emit(result: CommandResult): CommandResult {
        try {
            this.deps.hooks?.onResult?.(result);
        } catch {
            // ignore
        }

        return result;
    }
}
