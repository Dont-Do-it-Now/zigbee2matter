import {existsSync, readFileSync, writeFileSync} from "node:fs";
import WebSocket from "ws";
import data from "../util/data";

/**
 * Home Assistant OS helper: reads the official "Matter Server" add-on state through the Supervisor (`GET /addons/<slug>/info`,
 * allowed for the default add-on role; it never starts or controls other add-ons) and commissions this bridge into it over
 * python-matter-server's WebSocket (`commission_with_code`). If the Supervisor call fails, a WebSocket probe is used instead.
 * Only active when `SUPERVISOR_TOKEN` is present (running as a HAOS add-on).
 */

const SUPERVISOR_URL = "http://supervisor";

const ADDON_SLUG = "core_matter_server";
const MATTER_SERVER_PORT = 5580;
// Matter Server uses host networking, as does this add-on, so loopback works first. `core-matter-server` is the
// Supervisor DNS name, used as a fallback in case either add-on's networking changes.
const MATTER_SERVER_HOSTS = ["127.0.0.1", "core-matter-server"];

export const MATTER_SERVER_LINKS = {
    install: `https://my.home-assistant.io/redirect/supervisor_addon/?addon=${ADDON_SLUG}`,
    integration: "https://my.home-assistant.io/redirect/config_flow_start/?domain=matter",
} as const;

const HA_FABRICS_FILE = "ha-fabrics.json";
// Nabu Casa (python-matter-server's real root vendor id) and the 0xFFF1 test vendor.
const HA_VENDOR_IDS = new Set([4939, 65521]);

function readHaFabricIndexes(): number[] {
    try {
        const file = data.joinPath(HA_FABRICS_FILE);
        const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];

        return Array.isArray(parsed) ? parsed.filter((index): index is number => typeof index === "number") : [];
    } catch {
        return [];
    }
}

function writeHaFabricIndexes(indexes: number[]): void {
    try {
        writeFileSync(data.joinPath(HA_FABRICS_FILE), JSON.stringify([...new Set(indexes)]));
    } catch {
        // Best effort: vendor id / label detection still applies.
    }
}

/** Remembers fabric indexes that appeared while this bridge was commissioned into Home Assistant. */
export function recordHaFabrics(indexes: number[]): void {
    if (indexes.length > 0) writeHaFabricIndexes([...readHaFabricIndexes(), ...indexes]);
}

export function forgetHaFabric(index: number): void {
    writeHaFabricIndexes(readHaFabricIndexes().filter((recorded) => recorded !== index));
}

/** A fabric belongs to Home Assistant by vendor id, label, or because our own `ha/connect` created it. */
export function isHaFabric(fabric: {fabricIndex: number; label?: string; rootVendorId: number}): boolean {
    return (
        HA_VENDOR_IDS.has(fabric.rootVendorId) || /home\s*assistant/i.test(fabric.label ?? "") || readHaFabricIndexes().includes(fabric.fabricIndex)
    );
}

export type MatterServerErrorCode = "CONNECT_FAILED" | "COMMISSION_FAILED" | "COMMISSION_TIMEOUT" | "REMOVE_CONNECT_FAILED" | "REMOVE_FAILED";

export class MatterServerError extends Error {
    constructor(
        readonly code: MatterServerErrorCode,
        message: string,
    ) {
        super(message);
    }
}

export interface MatterServerStatus {
    readonly haos: boolean;
    readonly installed?: boolean;
    /** Supervisor add-on state (`started`, `stopped`, ...) or `not_installed`. */
    readonly state?: string;
    readonly links?: typeof MATTER_SERVER_LINKS;
}

export function isHaos(): boolean {
    return Boolean(process.env.SUPERVISOR_TOKEN);
}

function probeHost(host: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${host}:${MATTER_SERVER_PORT}/ws`, {handshakeTimeout: timeoutMs});
        const timer = setTimeout(() => done(false), timeoutMs);
        const done = (ok: boolean): void => {
            clearTimeout(timer);
            ws.removeAllListeners();
            ws.on("error", () => {});
            ws.terminate();
            resolve(ok);
        };
        ws.on("error", () => done(false));
        ws.on("close", () => done(false));
        ws.on("message", (raw) => {
            try {
                done("schema_version" in (JSON.parse(raw.toString()) as Record<string, unknown>));
            } catch {
                done(false);
            }
        });
    });
}

async function supervisorInfo(): Promise<{installed: boolean; state: string} | undefined> {
    try {
        const response = await fetch(`${SUPERVISOR_URL}/addons/${ADDON_SLUG}/info`, {
            headers: {Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`},
            signal: AbortSignal.timeout(10_000),
        });
        // Unknown/uninstalled slug answers 4xx; a store-only add-on has no installed version.
        if (response.status >= 500 || response.status === 401 || response.status === 403) return undefined;
        const body = (await response.json().catch(() => ({}))) as {data?: {version?: unknown; state?: unknown}};
        const installed = response.status === 200 && Boolean(body.data?.version);

        return {installed, state: installed ? String(body.data?.state ?? "unknown") : "not_installed"};
    } catch {
        return undefined;
    }
}

export async function getMatterServerStatus(): Promise<MatterServerStatus> {
    if (!isHaos()) return {haos: false};
    const info = await supervisorInfo();
    if (info) return {haos: true, ...info, links: MATTER_SERVER_LINKS};
    // Supervisor unavailable: fall back to probing the WebSocket directly.
    for (const host of MATTER_SERVER_HOSTS) {
        if (await probeHost(host, 3000)) return {haos: true, installed: true, state: "started", links: MATTER_SERVER_LINKS};
    }

    return {haos: true, installed: false, state: "not_installed", links: MATTER_SERVER_LINKS};
}

function commissionOnHost(host: string, code: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${host}:${MATTER_SERVER_PORT}/ws`, {handshakeTimeout: 5000});
        const messageId = String(Date.now());
        let sent = false;
        const finish = (error?: MatterServerError): void => {
            clearTimeout(timer);
            ws.removeAllListeners();
            ws.on("error", () => {});
            ws.terminate();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(
            () => finish(new MatterServerError(sent ? "COMMISSION_TIMEOUT" : "CONNECT_FAILED", `Matter Server did not respond on ${host} in time.`)),
            timeoutMs,
        );
        ws.on("error", (error) =>
            finish(new MatterServerError(sent ? "COMMISSION_FAILED" : "CONNECT_FAILED", `Matter Server ${host}: ${error.message}`)),
        );
        ws.on("close", () => finish(new MatterServerError(sent ? "COMMISSION_FAILED" : "CONNECT_FAILED", "Matter Server closed the connection.")));
        ws.on("message", (raw) => {
            let message: Record<string, unknown>;
            try {
                message = JSON.parse(raw.toString()) as Record<string, unknown>;
            } catch {
                return;
            }
            // First frame is `server_info` (no message_id): the server is ready for commands.
            if (!sent && message.message_id === undefined && "schema_version" in message) {
                sent = true;
                ws.send(JSON.stringify({message_id: messageId, command: "commission_with_code", args: {code, network_only: true}}));
            } else if (message.message_id === messageId) {
                if ("error_code" in message)
                    finish(new MatterServerError("COMMISSION_FAILED", String(message.details ?? `error_code ${String(message.error_code)}`)));
                else finish();
            }
        });
    });
}

/** Commissions this bridge (via its manual pairing `code`) into the HA Matter Server, trying each known host in order. */
export async function commissionIntoMatterServer(code: string, timeoutMs = 120_000): Promise<void> {
    let lastError: MatterServerError | undefined;
    for (const host of MATTER_SERVER_HOSTS) {
        try {
            await commissionOnHost(host, code, timeoutMs);
            return;
        } catch (error) {
            if (!(error instanceof MatterServerError) || error.code !== "CONNECT_FAILED") throw error;
            lastError = error;
        }
    }
    throw lastError ?? new MatterServerError("CONNECT_FAILED", "Matter Server is not reachable.");
}

function removeNodeOnHost(host: string, nodeId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!/^\d+$/.test(nodeId)) {
            reject(new MatterServerError("REMOVE_FAILED", "Matter Server node ID is invalid."));
            return;
        }
        const ws = new WebSocket(`ws://${host}:${MATTER_SERVER_PORT}/ws`, {handshakeTimeout: 5000});
        const messageId = String(Date.now());
        let sent = false;
        const finish = (error?: MatterServerError): void => {
            clearTimeout(timer);
            ws.removeAllListeners();
            ws.on("error", () => {});
            ws.terminate();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(
            () =>
                finish(
                    new MatterServerError(sent ? "REMOVE_FAILED" : "REMOVE_CONNECT_FAILED", `Matter Server did not remove node ${nodeId} in time.`),
                ),
            timeoutMs,
        );
        ws.on("error", (error) =>
            finish(new MatterServerError(sent ? "REMOVE_FAILED" : "REMOVE_CONNECT_FAILED", `Matter Server ${host}: ${error.message}`)),
        );
        ws.on("close", () => finish(new MatterServerError(sent ? "REMOVE_FAILED" : "REMOVE_CONNECT_FAILED", "Matter Server closed the connection.")));
        ws.on("message", (raw) => {
            let message: Record<string, unknown>;
            try {
                message = JSON.parse(raw.toString()) as Record<string, unknown>;
            } catch {
                return;
            }
            if (!sent && message.message_id === undefined && "schema_version" in message) {
                sent = true;
                // Matter node IDs are uint64. Keep the validated decimal token intact to avoid Number precision loss.
                ws.send(`{"message_id":${JSON.stringify(messageId)},"command":"remove_node","args":{"node_id":${nodeId}}}`);
            } else if (message.message_id === messageId) {
                if ("error_code" in message)
                    finish(new MatterServerError("REMOVE_FAILED", String(message.details ?? `error_code ${String(message.error_code)}`)));
                else finish();
            }
        });
    });
}

/** Removes a bridged node from the HA Matter Server before its local fabric is deleted. */
export async function removeNodeFromMatterServer(nodeId: string, timeoutMs = 30_000): Promise<void> {
    if (!isHaos()) throw new MatterServerError("REMOVE_FAILED", "Disconnect this bridge from the Matter controller first.");
    let lastError: MatterServerError | undefined;
    for (const host of MATTER_SERVER_HOSTS) {
        try {
            await removeNodeOnHost(host, nodeId, timeoutMs);
            return;
        } catch (error) {
            if (!(error instanceof MatterServerError) || error.code !== "REMOVE_CONNECT_FAILED") throw error;
            lastError = error;
        }
    }
    throw lastError ?? new MatterServerError("REMOVE_FAILED", "Matter Server could not remove this bridge.");
}
