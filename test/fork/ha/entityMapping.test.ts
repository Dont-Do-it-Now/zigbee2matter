// z2m-fork: T006-tests. Replaces the mapping assertions of the removed test/extensions/homeassistant.test.ts (see docs/evidence/T006-tests.md).
// Calls mapDeviceExposes directly: no HA extension, no discovery publishing, no broker.
import {describe, expect, it} from "vitest";
import "../../mocks/data";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import {entityValue, type HaEntityDefinition, mapDeviceExposes} from "../../../lib/ha/entityMapping";

const {presets: e, access: a} = exposes;

const NET = "11111111-1111-4111-8111-111111111111";
const IEEE = "0x00158d0001abcdef";
const IEEE16 = IEEE.slice(2);
const ctx = {
    networkId: NET,
    ieee: IEEE,
    endpointId: (label: string | undefined) => (label === undefined ? 1 : label === "l1" ? 1 : label === "l2" ? 2 : undefined),
};

const map = (...list: unknown[]): HaEntityDefinition[] => mapDeviceExposes(list as Parameters<typeof mapDeviceExposes>[0], ctx);
const find = (defs: HaEntityDefinition[], platform: string, objectId?: string): HaEntityDefinition => {
    const def = defs.find((d) => d.platform === platform && (objectId === undefined || d.objectId === objectId));
    if (!def) throw new Error(`no ${platform}/${objectId} in ${defs.map((d) => `${d.platform}/${d.objectId}`).join(",")}`);

    return def;
};

describe("HA entity mapping (no discovery publishing)", () => {
    it("maps a color light (was: light discovery) with state key, brightness and color modes", () => {
        const light = find(map(e.light_brightness_colorxy()), "light");
        expect(light.property).toBe("state");
        expect(light.commandProperty).toBe("state");
        expect(light.stateKey).toBe(`dev:${NET}:${IEEE16}:1:state`);
        expect(light.key).toBe(`dev:${NET}:${IEEE16}:1:ha/light/light`);
        expect(light.uniqueId).toBe(`zigbee2matter:${light.key}`);
        expect(light.config).toMatchObject({brightness: true, colorModes: ["xy"], onValue: "ON", offValue: "OFF", brightnessScale: 254});
        expect(light.matterCovered).toBe(true);
    });

    it("maps color_temp range of a white spectrum light", () => {
        const light = find(map(e.light_brightness_colortemp([250, 454])), "light");
        expect(light.config).toMatchObject({colorModes: ["color_temp"], minMireds: 250, maxMireds: 454});
    });

    it("maps a multi-endpoint switch (was: switch discovery) to per-endpoint entities with endpoint suffix stripped", () => {
        const defs = map(e.switch().withEndpoint("l1"), e.switch().withEndpoint("l2"));
        const l1 = find(defs, "switch", "switch_l1");
        const l2 = find(defs, "switch", "switch_l2");
        expect(l1.property).toBe("state");
        expect(l1.endpointId).toBe(1);
        expect(l1.stateKey).toBe(`dev:${NET}:${IEEE16}:1:state`);
        expect(l2.endpointId).toBe(2);
        expect(l2.stateKey).toBe(`dev:${NET}:${IEEE16}:2:state`);
        expect(l1.config).toMatchObject({onValue: "ON", offValue: "OFF"});
        expect(l1.uniqueId).not.toBe(l2.uniqueId);
    });

    it("skips an endpoint label that cannot be resolved", () => {
        expect(map(e.switch().withEndpoint("l9"))).toStrictEqual([]);
    });

    it("maps temperature/humidity/battery sensors (was: sensor discovery) with device_class, unit and state_class", () => {
        const defs = map(e.temperature(), e.humidity(), e.battery());
        const temperature = find(defs, "sensor", "temperature");
        expect(temperature).toMatchObject({deviceClass: "temperature", unit: "°C", stateClass: "measurement", property: "temperature"});
        expect(temperature.commandProperty).toBeUndefined();
        expect(find(defs, "sensor", "humidity")).toMatchObject({deviceClass: "humidity", unit: "%", property: "humidity"});
        expect(find(defs, "sensor", "battery")).toMatchObject({deviceClass: "battery", unit: "%", property: "battery"});
        expect(temperature.matterCovered).toBe(true);
    });

    it("maps a cover with position (was: cover discovery)", () => {
        const cover = find(map(e.cover_position()), "cover");
        expect(cover.property).toBe("state");
        expect(cover.config).toMatchObject({openValue: "OPEN", closeValue: "CLOSE", stopValue: "STOP", positionProperty: "position"});
    });

    it("maps a lock (was: lock discovery) with locked/unlocked values", () => {
        const lock = find(map(e.lock()), "lock");
        expect(lock.property).toBe("state");
        expect(lock.commandProperty).toBe("state");
        expect(lock.config).toMatchObject({lockedValue: "LOCK", unlockedValue: "UNLOCK"});
    });

    it("maps a thermostat (was: climate discovery) with setpoint range, mode and running state", () => {
        const climate = find(
            map(
                e
                    .climate()
                    .withSetpoint("occupied_heating_setpoint", 7, 30, 0.5)
                    .withLocalTemperature()
                    .withSystemMode(["off", "heat", "auto"])
                    .withRunningState(["idle", "heat"]),
            ),
            "climate",
        );
        expect(climate.config).toMatchObject({
            minTemp: 7,
            maxTemp: 30,
            step: 0.5,
            currentTemperatureProperty: "local_temperature",
            heatingSetpointProperty: "occupied_heating_setpoint",
            modeProperty: "system_mode",
            modes: ["off", "heat", "auto"],
            runningStateProperty: "running_state",
        });
        expect(climate.property).toBe("local_temperature");
        expect(climate.commandProperty).toBe("occupied_heating_setpoint");
        expect(climate.unit).toBe("°C");
    });

    it("does not map a climate without a local temperature", () => {
        expect(map(e.climate().withSetpoint("occupied_heating_setpoint", 7, 30, 0.5))).toStrictEqual([]);
    });

    it("maps power/energy/current sensors (was: sensor discovery) with derived classes from the unit", () => {
        const defs = map(e.power(), e.energy(), e.current());
        expect(find(defs, "sensor", "power")).toMatchObject({deviceClass: "power", stateClass: "measurement", unit: "W"});
        expect(find(defs, "sensor", "energy")).toMatchObject({deviceClass: "energy", stateClass: "total_increasing", unit: "kWh"});
        expect(find(defs, "sensor", "current")).toMatchObject({deviceClass: "current", stateClass: "measurement", unit: "A"});
    });

    it("exposes the button/remote `action` enum as a button event entity", () => {
        const defs = map(e.action(["single", "double", "hold"]));
        expect(defs).toHaveLength(1);
        expect(defs[0]).toMatchObject({
            platform: "event",
            objectId: "action",
            property: "action",
            deviceClass: "button",
            config: {eventTypes: ["single", "double", "hold"]},
        });
        expect(defs[0].commandProperty).toBeUndefined();
    });

    it("maps a settable binary to a switch and a read-only binary to a binary_sensor", () => {
        const defs = map(e.binary("child_lock", a.STATE_SET, "LOCK", "UNLOCK"), e.occupancy());
        expect(find(defs, "switch", "switch_child_lock")).toMatchObject({property: "child_lock", commandProperty: "child_lock"});
        expect(find(defs, "binary_sensor", "occupancy")).toMatchObject({deviceClass: "occupancy", property: "occupancy"});
    });

    it("reads entity values from the observed state record by property", () => {
        const temperature = find(map(e.temperature()), "sensor", "temperature");
        expect(entityValue(temperature, {temperature: 21.5, humidity: 40})).toBe(21.5);
        expect(entityValue(temperature, {humidity: 40})).toBeUndefined();
        expect(entityValue(temperature, undefined)).toBeUndefined();
        expect(entityValue(find(map(e.action(["single"])), "event"), {action: "single"})).toBe("single");
    });

    it("is stable and unique: same exposes give identical unique ids, keys never collide", () => {
        const first = map(e.switch().withEndpoint("l1"), e.switch().withEndpoint("l2"), e.temperature());
        const second = map(e.switch().withEndpoint("l1"), e.switch().withEndpoint("l2"), e.temperature());
        expect(first.map((d) => d.uniqueId)).toStrictEqual(second.map((d) => d.uniqueId));
        expect(new Set(first.map((d) => d.key)).size).toBe(first.length);
    });

    it("ignores unsupported expose types (text)", () => {
        expect(map(e.text("note", a.STATE_SET).withLabel("Note"))).toStrictEqual([]);
    });

    it("honours a custom matterCovered decision", () => {
        const defs = mapDeviceExposes([e.light_brightness()] as Parameters<typeof mapDeviceExposes>[0], {...ctx, matterCovered: () => false});
        expect(defs[0].matterCovered).toBe(false);
    });
});
