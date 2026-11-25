// z2m-fork: HaBridge syncDevice/removeDevice/applyState/hybrid. Fake router/hybrid only: no HA transport, no Matter SDK.
import {describe, expect, it} from "vitest";
import "../../mocks/data";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import {type HaEntityDefinition, mapDeviceExposes} from "../../../lib/ha/entityMapping";
import {HaBridge} from "../../../lib/ha/haBridge";

const {presets: e} = exposes;
const NET = "11111111-1111-4111-8111-111111111111";
const IEEE = "0x00158d0001abcdef";
const ctx = {networkId: NET, ieee: IEEE, endpointId: () => 1};
const map = (...list: unknown[]): HaEntityDefinition[] => mapDeviceExposes(list as Parameters<typeof mapDeviceExposes>[0], ctx);

function fakes() {
    const calls: {method: string; args: unknown[]}[] = [];
    const bindings: {key: string; directUniqueId: string}[] = [];
    const router = {
        register: (...args: unknown[]) => calls.push({method: "register", args}),
        setAvailability: (...args: unknown[]) => calls.push({method: "setAvailability", args}),
        publishState: (...args: unknown[]) => calls.push({method: "publishState", args}),
    };
    const hybrid = {
        list: () => bindings,
        bind: (binding: {key: string; directUniqueId: string}) => bindings.push(binding),
        setMode: (mode: string) => calls.push({method: "setMode", args: [mode]}),
    };

    return {calls, bindings, router, hybrid};
}
const make = (f: ReturnType<typeof fakes>, options: Record<string, unknown> = {}) =>
    new HaBridge(f.router as never, {...options, hybrid: options.hybrid ? (f.hybrid as never) : undefined} as never);
const named = (f: ReturnType<typeof fakes>, method: string) => f.calls.filter((c) => c.method === method);

describe("HaBridge", () => {
    it("syncDevice registers every definition as direct and indexes them", () => {
        const f = fakes();
        const bridge = make(f);
        const defs = map(e.light_brightness());
        bridge.syncDevice("dev1", defs);

        expect(named(f, "register")).toHaveLength(defs.length);
        expect(named(f, "register")[0].args[0]).toBe("direct");
        expect(bridge.definitions("dev1")).toHaveLength(defs.length);
        expect(bridge.definitions()).toHaveLength(defs.length);
    });

    it("syncDevice marks vanished entities unavailable instead of removing them", () => {
        const f = fakes();
        const bridge = make(f);
        bridge.syncDevice("dev1", map(e.light_brightness(), e.temperature()));
        const before = named(f, "setAvailability").length;
        bridge.syncDevice("dev1", map(e.light_brightness()));
        const after = named(f, "setAvailability").slice(before);

        expect(after).toHaveLength(1);
        expect(after[0].args[2]).toBe(false);
    });

    it("removeDevice marks entities unavailable and drops state routing", () => {
        const f = fakes();
        const bridge = make(f);
        const defs = map(e.light_brightness());
        bridge.syncDevice("dev1", defs);
        bridge.removeDevice("dev1");

        expect(named(f, "setAvailability").some((c) => c.args[2] === false)).toBe(true);
        expect(bridge.definitions("dev1")).toEqual([]);
        const before = f.calls.length;
        bridge.applyState({key: defs[0].stateKey, observedValue: {state: "ON"}});
        expect(f.calls.length).toBe(before);
        bridge.removeDevice("unknown");
    });

    it("applyState publishes the mapped property value and availability", () => {
        const f = fakes();
        const bridge = make(f);
        const light = map(e.light_brightness()).find((d) => d.platform === "light") as HaEntityDefinition;
        bridge.syncDevice("dev1", [light]);
        bridge.applyState({key: light.stateKey, observedValue: {state: "ON"}, availability: true, observedAt: 42});

        expect(named(f, "setAvailability").pop()?.args[2]).toBe(true);
        const published = named(f, "publishState").pop();
        expect(published?.args[2]).toBe("ON");
        expect(published?.args[3]).toBe(42);
    });

    it("applyState skips unknown keys, missing property values and swallows router errors", () => {
        const f = fakes();
        const bridge = make(f);
        const light = map(e.light_brightness()).find((d) => d.platform === "light") as HaEntityDefinition;
        bridge.syncDevice("dev1", [light]);
        const before = named(f, "publishState").length;
        bridge.applyState({key: "dev:other:key:1:state", observedValue: {state: "ON"}});
        bridge.applyState({key: light.stateKey, observedValue: {}});
        bridge.applyState({key: light.stateKey});
        expect(named(f, "publishState")).toHaveLength(before);

        f.router.publishState = () => {
            throw new Error("not registered");
        };
        expect(() => bridge.applyState({key: light.stateKey, observedValue: {state: "OFF"}})).not.toThrow();
    });

    it("hybrid: matterCovered entities are not exposed or bound for Direct", () => {
        const f = fakes();
        const bridge = make(f, {mode: "hybrid", hybrid: true});
        const covered = map(e.light_brightness()).find((d) => d.platform === "light") as HaEntityDefinition;
        const uncovered: HaEntityDefinition = {...covered, key: covered.key.replace("light/light", "light/other"), matterCovered: false};
        bridge.syncDevice("dev1", [covered, uncovered]);

        expect(bridge.exposesDirect(covered)).toBe(false);
        expect(bridge.exposesDirect(uncovered)).toBe(true);
        expect(bridge.restEntities("dev1")).toEqual([uncovered]);
        expect(f.bindings.map((b) => b.key)).toEqual([uncovered.key]);
        bridge.syncDevice("dev1", [covered, uncovered]);
        expect(f.bindings).toHaveLength(1);
    });

    it("direct mode exposes everything and matter mode exposes nothing; setMode propagates to hybrid", () => {
        const f = fakes();
        const bridge = make(f, {hybrid: true});
        const defs = map(e.light_brightness());
        bridge.syncDevice("dev1", defs);
        expect(bridge.restEntities("dev1")).toHaveLength(defs.length);
        bridge.setMode("matter");
        expect(bridge.restEntities("dev1")).toEqual([]);
        expect(named(f, "setMode").pop()?.args[0]).toBe("matter");
    });

    it("translateCommand builds set payloads and rejects unsupported services", () => {
        const f = fakes();
        const bridge = make(f);
        const light = map(e.light_brightness()).find((d) => d.platform === "light") as HaEntityDefinition;
        expect(bridge.translateCommand(light, "turn_off").data).toEqual({state: "OFF"});
        expect(bridge.translateCommand(light, "turn_on", {brightness: 10}).data).toEqual({state: "ON", brightness: 10});
        expect(() => bridge.translateCommand(light, "toggle")).toThrow("unsupported HA service");
    });
});
