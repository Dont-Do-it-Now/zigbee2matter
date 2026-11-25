// z2m-fork: HA Matter Server helper. Fake Supervisor (fetch stub) and fake python-matter-server (ws on 127.0.0.1:5580).
import {afterEach, describe, expect, it, vi} from "vitest";
import {WebSocketServer} from "ws";
import {commissionIntoMatterServer, getMatterServerStatus, MatterServerError} from "../../../lib/ha/matterServer";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const stubSupervisor = (status: number, data?: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({status, json: async () => ({data})}));

describe("getMatterServerStatus", () => {
    it("is not HAOS without SUPERVISOR_TOKEN", async () => {
        vi.stubEnv("SUPERVISOR_TOKEN", "");
        expect(await getMatterServerStatus()).toEqual({haos: false});
    });

    it("reports started / not installed", async () => {
        vi.stubEnv("SUPERVISOR_TOKEN", "t");
        stubSupervisor(200, {version: "8.0.0", state: "started"});
        expect(await getMatterServerStatus()).toMatchObject({haos: true, installed: true, state: "started"});
        stubSupervisor(400);
        expect(await getMatterServerStatus()).toMatchObject({installed: false, state: "not_installed"});
    });
});

describe("commissionIntoMatterServer", () => {
    const serve = (reply: (id: string) => Record<string, unknown>) => {
        const server = new WebSocketServer({host: "127.0.0.1", port: 5580, path: "/ws"});
        server.on("connection", (ws) => {
            ws.send(JSON.stringify({fabric_id: 1, schema_version: 11, sdk_version: "x"}));
            ws.on("message", (raw) => {
                const message = JSON.parse(raw.toString());
                expect(message).toMatchObject({command: "commission_with_code", args: {code: "34970112332", network_only: true}});
                ws.send(JSON.stringify(reply(message.message_id)));
            });
        });
        return server;
    };

    it("resolves on a matching result", async () => {
        const server = serve((id) => ({message_id: id, result: {node_id: 5}}));
        try {
            await expect(commissionIntoMatterServer("34970112332", 5000)).resolves.toBeUndefined();
        } finally {
            server.close();
        }
    });

    it("rejects with COMMISSION_FAILED on an error result", async () => {
        const server = serve((id) => ({message_id: id, error_code: 5, details: "Commission failed"}));
        try {
            await expect(commissionIntoMatterServer("34970112332", 5000)).rejects.toBeInstanceOf(MatterServerError);
        } finally {
            server.close();
        }
    });
});
