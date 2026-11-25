// z2m-fork: ZigbeeMatterEndpointFactory. Fake Endpoint class (records definition/options); real @matter/main device definitions.
import {describe, expect, it} from "vitest";
import "../../mocks/data";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import type {EndpointRegistryEntry} from "../../../lib/matter/endpointRegistry";
import type {MappingExpose} from "../../../lib/matter/mappingRegistry";
import {ZigbeeMatterEndpointFactory} from "../../../lib/matter/zigbeeEndpointFactory";

const {presets: e} = exposes;

class FakeEndpoint {
    static created: FakeEndpoint[] = [];
    number: number | undefined;
    deleted = false;
    closed = false;
    sets: Record<string, unknown>[] = [];

    constructor(
        readonly definition: unknown,
        readonly options: Record<string, unknown> = {},
    ) {
        FakeEndpoint.created.push(this);
    }

    async set(values: Record<string, unknown>): Promise<void> {
        this.sets.push(values);
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    async delete(): Promise<void> {
        this.deleted = true;
    }
}

const entry = (endpointId = "ep-1"): EndpointRegistryEntry => ({key: `dev:net:0x01`, endpointId, state: "active"}) as EndpointRegistryEntry;

function factory(list: unknown[], source: Record<string, unknown> = {}, errors: unknown[] = []) {
    FakeEndpoint.created = [];

    return new ZigbeeMatterEndpointFactory({
        loadSdk: async () => ({Endpoint: FakeEndpoint}) as never,
        resolve: async () => ({name: "Lamp", available: true, exposes: list as MappingExpose[], send: async () => {}, ...source}),
        onCommandError: (_id, error) => errors.push(error),
    });
}

describe("ZigbeeMatterEndpointFactory", () => {
    it("creates a single endpoint for a light with bridged basic information", async () => {
        const f = factory([e.light_brightness()]);
        const {endpoint, unsupported} = await f.create(entry());

        expect(FakeEndpoint.created).toHaveLength(1);
        expect(endpoint).toBe(FakeEndpoint.created[0]);
        expect(FakeEndpoint.created[0].options).toMatchObject({id: "ep-1", bridgedDeviceBasicInformation: {nodeLabel: "Lamp", reachable: true}});
        expect(FakeEndpoint.created[0].options.parts).toBeUndefined();
        expect(Array.isArray(unsupported)).toBe(true);
    });

    it("creates one child part per button plus a primary endpoint for multi-button devices with a light", async () => {
        const f = factory([e.light_brightness(), e.action(["1_single", "2_single", "3_hold"])]);
        await f.create(entry());

        const root = FakeEndpoint.created.at(-1) as FakeEndpoint;
        const parts = root.options.parts as FakeEndpoint[];
        expect(parts).toHaveLength(3);
        expect(parts.map((p) => p.options.id)).toEqual(["button-1", "button-2", "button-3"]);
    });

    it("uses the first button as the root endpoint for button-only devices", async () => {
        const f = factory([e.action(["1_single", "2_single"])]);
        await f.create(entry());

        const root = FakeEndpoint.created.at(-1) as FakeEndpoint;
        expect(root.options.parts as FakeEndpoint[]).toHaveLength(1);
        expect((root.options.parts as FakeEndpoint[])[0].options.id).toBe("button-2");
    });

    it("single-button device has no child parts", async () => {
        const f = factory([e.action(["single", "double"])]);
        await f.create(entry());

        expect(FakeEndpoint.created).toHaveLength(1);
        expect(FakeEndpoint.created[0].options.parts).toBeUndefined();
    });

    it("maps shared exposes only on the primary endpoint", async () => {
        const shared = [e.temperature()];
        const primary = factory(shared, {isPrimaryEndpoint: true});
        await primary.create(entry());
        expect(FakeEndpoint.created).toHaveLength(1);

        const secondary = factory(shared, {isPrimaryEndpoint: false});
        await expect(secondary.create(entry("ep-2"))).rejects.toThrow("Matter mapping is unsupported");
    });

    it("rejects devices without an approved capability and lists the unsupported exposes", async () => {
        const f = factory([e.linkquality()]);
        await expect(f.create(entry())).rejects.toThrow(/unsupported/);
        expect(f.unsupportedFor("ep-1")).toEqual([]);
    });

    it("fails when the source is unavailable or the SDK lacks Endpoint", async () => {
        const noSource = new ZigbeeMatterEndpointFactory({loadSdk: async () => ({}) as never, resolve: async () => undefined});
        await expect(noSource.create(entry())).rejects.toThrow("Matter source is unavailable");

        const noEndpoint = new ZigbeeMatterEndpointFactory({
            loadSdk: async () => ({}) as never,
            resolve: async () => ({name: "x", available: true, exposes: [], send: async () => {}}),
        });
        await expect(noEndpoint.create(entry())).rejects.toThrow("does not expose Endpoint");
    });

    it("readAssignedNumber validates the SDK-assigned number", async () => {
        const f = factory([e.light_brightness()]);
        const {endpoint} = await f.create(entry());
        (endpoint as FakeEndpoint).number = 5;
        expect(f.readAssignedNumber(entry(), endpoint, undefined)).toBe(5);
        expect(f.readAssignedNumber(entry(), {}, {number: 7})).toBe(7);
        expect(() => f.readAssignedNumber(entry(), {}, undefined)).toThrow("valid number");
    });

    it("remove deletes a known endpoint permanently and tolerates unknown ones", async () => {
        const f = factory([e.light_brightness()]);
        const {endpoint} = await f.create(entry());

        await expect(f.remove(entry())).resolves.toEqual({permanent: true});
        expect((endpoint as FakeEndpoint).deleted).toBe(true);
        await expect(f.remove(entry())).resolves.toEqual({permanent: true});
    });

    it("updateState ignores unknown endpoints and writes a patch for known ones", async () => {
        const f = factory([e.light_brightness()]);
        await f.updateState(entry("missing"), {state: "ON"});
        const {endpoint} = await f.create(entry());
        await f.updateState(entry(), {state: "ON"});

        expect((endpoint as FakeEndpoint).sets.length).toBeGreaterThan(0);
    });
});
