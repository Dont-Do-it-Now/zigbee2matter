import type {AuthDecision, Command, CommandIdentity} from "./types";

export type CommandScope = NonNullable<CommandIdentity["scope"]>;

const SCOPE_RANK: Readonly<Record<CommandScope, number>> = {read: 1, control: 2, admin: 3};

/**
 * T012 required scope per bridge request. Hierarchy: admin includes control includes read.
 * Anything that changes the network, device/group registry, settings or restarts the process is `admin`.
 * Requests missing from this table (including unknown ones) require `admin`.
 */
export const BRIDGE_REQUEST_SCOPES: ReadonlyMap<string, CommandScope> = new Map<string, CommandScope>([
    ["health_check", "read"],
    ["coordinator_check", "read"],
    ["device/reporting/read", "control"],
    ["touchlink/identify", "control"],
    ["touchlink/scan", "control"],
    ["permit_join", "admin"],
    ["restart", "admin"],
    ["options", "admin"],
    ["backup", "admin"],
    ["install_code/add", "admin"],
    ["action", "admin"],
    ["touchlink/factory_reset", "admin"],
    ["device/options", "admin"],
    ["device/configure_reporting", "admin"],
    ["device/reporting/configure", "admin"],
    ["device/remove", "admin"],
    ["device/interview", "admin"],
    ["device/generate_external_definition", "admin"],
    ["device/rename", "admin"],
    ["group/add", "admin"],
    ["group/options", "admin"],
    ["group/remove", "admin"],
    ["group/rename", "admin"],
]);

/** Entity `get` needs `read`; entity `set` needs `control`; bridge requests follow `BRIDGE_REQUEST_SCOPES` (default `admin`). */
export function requiredScope(command: Command): CommandScope {
    if (command.operation === "get") {
        return "read";
    }

    if (command.operation === "set") {
        return "control";
    }

    return BRIDGE_REQUEST_SCOPES.get(command.target.request) ?? "admin";
}

/** Scope-only authorization decision. A missing scope is UNAUTHORIZED, an insufficient one FORBIDDEN. */
export function authorizeByScope(command: Command): AuthDecision {
    const granted = command.identity?.scope;

    if (granted === undefined || !Object.hasOwn(SCOPE_RANK, granted)) {
        return {ok: false, errorCode: "UNAUTHORIZED", message: "no command scope"};
    }

    return SCOPE_RANK[granted] >= SCOPE_RANK[requiredScope(command)]
        ? {ok: true}
        : {ok: false, errorCode: "FORBIDDEN", message: "insufficient command scope"};
}
