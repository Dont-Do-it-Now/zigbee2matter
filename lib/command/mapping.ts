import {BASE_TOPIC} from "../bridgeBus/constants";
import type {Command, CommandErrorCode, EntityTarget} from "./types";

/** Keys of `bridge/request/*` handled by upstream `ExtensionBridge.requestLookup`. Others get NO response upstream, so are rejected up front. */
export const KNOWN_BRIDGE_REQUESTS: ReadonlySet<string> = new Set([
    "device/options",
    "device/configure_reporting",
    "device/reporting/configure",
    "device/reporting/read",
    "device/remove",
    "device/interview",
    "device/generate_external_definition",
    "device/rename",
    "group/add",
    "group/options",
    "group/remove",
    "group/rename",
    "permit_join",
    "restart",
    "backup",
    "touchlink/factory_reset",
    "touchlink/identify",
    "install_code/add",
    "touchlink/scan",
    "health_check",
    "coordinator_check",
    "options",
    "action",
]);

/**
 * Requests whose response/side effect may carry secrets or keys (network key backup, install codes, external definition source).
 * Rejected with FORBIDDEN unless the router is explicitly configured with `allowedSensitiveRequests`.
 */
export const SENSITIVE_BRIDGE_REQUESTS: ReadonlySet<string> = new Set(["backup", "install_code/add", "device/generate_external_definition"]);

/** Bridge requests safe to repeat (same end state). Everything else is treated as non-idempotent. */
const IDEMPOTENT_BRIDGE_REQUESTS: ReadonlySet<string> = new Set([
    "device/options",
    "group/options",
    "device/reporting/read",
    "device/reporting/configure",
    "device/configure_reporting",
    "health_check",
    "coordinator_check",
    "options",
    "touchlink/scan",
    "permit_join",
]);

/** `state` values that toggle/latch (C3: no auto retry). */
const NON_IDEMPOTENT_STATE_VALUES: ReadonlySet<string> = new Set(["toggle", "lock", "unlock"]);
const SCENE_KEYS: ReadonlySet<string> = new Set(["scene_recall", "scene_store", "scene_add", "scene_remove", "scene_remove_all", "scene_rename"]);
/** Relative/step converters (`brightness_move`, `color_temp_step`, ...). */
const RELATIVE_KEY_RE = /_(?:move|step)(?:_|$)/;
const STATE_KEY_RE = /^(?:state|lock_state)(?:_.+)?$/;

/** C3: toggle/lock/scene (and relative move/step) must not be auto retried. `get` is always idempotent. */
export function isIdempotent(command: Command): boolean {
    if (command.operation === "get") {
        return true;
    }

    if (command.operation === "request") {
        return IDEMPOTENT_BRIDGE_REQUESTS.has(command.target.request);
    }

    for (const [key, value] of Object.entries(command.value)) {
        if (SCENE_KEYS.has(key) || RELATIVE_KEY_RE.test(key)) {
            return false;
        }

        if (STATE_KEY_RE.test(key) && typeof value === "string" && NON_IDEMPOTENT_STATE_VALUES.has(value.toLowerCase())) {
            return false;
        }
    }

    return true;
}

/**
 * Keys whose published value cannot be compared with the requested value (toggle, relative move/step, scene_*, non-primitive values):
 * correlation falls back to key presence.
 */
export function isExistenceOnlyKey(key: string, value: unknown): boolean {
    if (SCENE_KEYS.has(key) || RELATIVE_KEY_RE.test(key)) {
        return true;
    }

    if (STATE_KEY_RE.test(key) && typeof value === "string" && NON_IDEMPOTENT_STATE_VALUES.has(value.toLowerCase())) {
        return true;
    }

    return typeof value === "object" || value === undefined;
}

/** Upstream topic regex (`publish.ts`): `<base>/(?!bridge)(.+?)/(get|set)(?:/(.+))?$`. The endpoint segment sits between name and get/set. */
export function buildEntityTopic(name: string, endpoint: string | undefined, operation: "set" | "get"): string {
    return endpoint === undefined ? `${BASE_TOPIC}/${name}/${operation}` : `${BASE_TOPIC}/${name}/${endpoint}/${operation}`;
}

export function buildBridgeRequestTopic(request: string): string {
    return `${BASE_TOPIC}/bridge/request/${request}`;
}

/** Topic prefix of upstream request responses (`bridge.ts`: `bridge/response/${match[1]}`, published with base topic). */
export const BRIDGE_RESPONSE_PREFIX = `${BASE_TOPIC}/bridge/response/`;

/** Entity state topic published by `Controller.publishEntityState`. */
export function entityStateTopic(name: string): string {
    return `${BASE_TOPIC}/${name}`;
}

/** Rejects names that would break the upstream topic grammar (wildcards, empty/edge slashes, `bridge` prefix, slash in endpoint). */
export function isValidEntityName(target: EntityTarget): boolean {
    const bad = (s: string): boolean => s.length === 0 || /[+#]/.test(s) || s.startsWith("/") || s.endsWith("/");

    return (
        !bad(target.entity) &&
        !target.entity.startsWith("bridge") &&
        (target.endpoint === undefined || (!bad(target.endpoint) && !target.endpoint.includes("/")))
    );
}

const MAX_ERROR_LENGTH = 200;

/**
 * Upstream bridge errors are free text (`Zigbee2MQTTResponseError.error`, `bridge.ts` `throw new Error(...)`). Heuristic mapping,
 * unknown text -> INTERNAL. Source strings: "Invalid payload", "Invalid action", "... does not exist", "... does not have endpoint ...",
 * "No device has joined since start".
 */
export function classifyBridgeError(message: string): CommandErrorCode {
    if (/^Invalid (?:payload|action)/.test(message)) {
        return "INVALID_ARGUMENT";
    }

    if (/does not exist|does not have endpoint|No device has joined/.test(message)) {
        return "NOT_FOUND";
    }

    return "INTERNAL";
}

export function sanitizeErrorMessage(message: string): string {
    return message.length > MAX_ERROR_LENGTH ? `${message.substring(0, MAX_ERROR_LENGTH)}...` : message;
}
