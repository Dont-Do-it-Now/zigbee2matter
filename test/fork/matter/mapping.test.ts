import {describe, expect, it} from "vitest";

import {
    DEFAULT_BUTTON,
    deriveButtons,
    mapButtonAction,
    mapButtonActionSequence,
    splitButtonAction,
    toSwitchEmission,
} from "../../../lib/matter/buttonMapping";
import {mapCoverAction, mapCoverMovement, matterPercent100thsToZigbee, zigbeeToMatterPercent100ths} from "../../../lib/matter/coverMapping";
import {EnergyAccumulator, isKnownElectricalUnit, toMatterElectrical, toWattHours, toWatts} from "../../../lib/matter/energyMapping";
import {type MappingExpose, planEndpointMapping} from "../../../lib/matter/mappingRegistry";
import {
    booleanSensorBySemantic,
    booleanSensorToMatter,
    celsiusToMatter,
    humidityPercentToMatter,
    occupancyToMatter,
} from "../../../lib/matter/sensorMapping";

const names = (events: ReadonlyArray<{event: string; pressCount?: number}>): string[] =>
    events.map((e) => (e.pressCount === undefined ? e.event : `${e.event}(${e.pressCount})`));

describe("button sequences", () => {
    it("single press -> InitialPress, ShortRelease, MultiPressComplete(1)", () => {
        const result = mapButtonActionSequence("single");
        expect(result).toMatchObject({supported: true, longActive: false});
        if (result.supported) expect(names(result.events)).toEqual(["initialPress", "shortRelease", "multiPressComplete(1)"]);
    });

    it.each([
        ["double", ["initialPress", "shortRelease", "multiPressOngoing(2)", "shortRelease", "multiPressComplete(2)"]],
        [
            "triple",
            ["initialPress", "shortRelease", "multiPressOngoing(2)", "shortRelease", "multiPressOngoing(3)", "shortRelease", "multiPressComplete(3)"],
        ],
    ])("%s press follows the Matter MultiPress order", (action, expected) => {
        const result = mapButtonActionSequence(action);
        expect(result.supported).toBe(true);
        if (result.supported) expect(names(result.events)).toEqual(expected);
    });

    it("hold -> InitialPress, LongPress and release afterwards is LongRelease; without hold it is ShortRelease", () => {
        const hold = mapButtonActionSequence("hold");
        expect(hold).toMatchObject({supported: true, longActive: true});
        if (hold.supported) expect(names(hold.events)).toEqual(["initialPress", "longPress"]);

        const afterHold = mapButtonActionSequence("release", true);
        if (afterHold.supported) expect(names(afterHold.events)).toEqual(["longRelease"]);
        const plain = mapButtonActionSequence("release", false);
        if (plain.supported) expect(names(plain.events)).toEqual(["shortRelease"]);
    });

    it("multi-button remotes: prefix and suffix forms carry the button id", () => {
        expect(mapButtonActionSequence("1_single")).toMatchObject({supported: true, button: "1"});
        expect(mapButtonActionSequence("single_2")).toMatchObject({supported: true, button: "2"});
        expect(mapButtonActionSequence("up_hold")).toMatchObject({supported: true, button: "up", longActive: true});
        expect(mapButtonActionSequence("single")).toMatchObject({supported: true, button: undefined});
    });

    it.each(["brightness_move_up", "brightness_move_down", "brightness_stop", "color_temperature_move", "recall_1", "off", "toggle", "", "single_"])(
        "does not misparse the non-button action %j (no false-positive button)",
        (action) => {
            expect(splitButtonAction(action)).toBeUndefined();
            expect(mapButtonActionSequence(action)).toMatchObject({supported: false});
        },
    );

    it("deriveButtons ignores unparseable values and sorts numerically with the default button first", () => {
        expect(deriveButtons(["1_single", "10_single", "2_hold", "brightness_move_up", "toggle"])).toEqual(["1", "2", "10"]);
        expect(deriveButtons(["single", "double", "1_single"])).toEqual([DEFAULT_BUTTON, "1"]);
        expect(deriveButtons(["brightness_move_up"])).toEqual([DEFAULT_BUTTON]);
        expect(deriveButtons(undefined)).toEqual([DEFAULT_BUTTON]);
    });

    it("mapButtonAction validates pressCount per event and rejects unknown actions", () => {
        expect(mapButtonAction("initial_press")).toEqual({supported: true, value: {event: "initialPress"}});
        expect(mapButtonAction("initial_press", 1)).toMatchObject({supported: false});
        expect(mapButtonAction("multi_press_complete")).toMatchObject({supported: false});
        expect(mapButtonAction("multi_press_complete", 1)).toMatchObject({supported: false});
        expect(mapButtonAction("multi_press_complete", 2)).toEqual({supported: true, value: {event: "multiPressComplete", pressCount: 2}});
        expect(mapButtonAction("MULTI_PRESS_COMPLETE", 3)).toMatchObject({supported: true});
        expect(mapButtonAction("nonsense")).toMatchObject({supported: false});
    });

    it("emits Matter Switch event payloads with momentary positions", () => {
        expect(toSwitchEmission({event: "initialPress"})).toEqual({name: "initialPress", payload: {newPosition: 1}});
        expect(toSwitchEmission({event: "longRelease"})).toEqual({name: "longRelease", payload: {previousPosition: 1}});
        expect(toSwitchEmission({event: "multiPressOngoing", pressCount: 3})).toEqual({
            name: "multiPressOngoing",
            payload: {newPosition: 1, currentNumberOfPressesCounted: 3},
        });
        expect(toSwitchEmission({event: "multiPressComplete", pressCount: 2})).toEqual({
            name: "multiPressComplete",
            payload: {previousPosition: 1, totalNumberOfPressesCounted: 2},
        });
    });
});

describe("cover mapping", () => {
    it("inverts z2m position (100=open) to Matter percent100ths (0=open)", () => {
        expect(zigbeeToMatterPercent100ths(100)).toBe(0);
        expect(zigbeeToMatterPercent100ths(0)).toBe(10000);
        expect(zigbeeToMatterPercent100ths(37)).toBe(6300);
        expect(matterPercent100thsToZigbee(0)).toBe(100);
        expect(matterPercent100thsToZigbee(10000)).toBe(0);
        expect(matterPercent100thsToZigbee(6300)).toBe(37);
    });

    it("invert=true keeps the device value meaning (no inversion) and still round-trips", () => {
        expect(zigbeeToMatterPercent100ths(100, true)).toBe(10000);
        expect(zigbeeToMatterPercent100ths(0, true)).toBe(0);
        expect(matterPercent100thsToZigbee(zigbeeToMatterPercent100ths(25, true), true)).toBe(25);
        expect(matterPercent100thsToZigbee(zigbeeToMatterPercent100ths(25), false)).toBe(25);
    });

    it("rejects out-of-range and non-finite values", () => {
        for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => zigbeeToMatterPercent100ths(bad)).toThrow();
        for (const bad of [-1, 10001, Number.NaN]) expect(() => matterPercent100thsToZigbee(bad)).toThrow();
    });

    it("maps actions and movements case-insensitively and leaves unknown values undefined", () => {
        expect(mapCoverAction(" OPEN ")).toBe("open");
        expect(mapCoverAction("toggle")).toBeUndefined();
        expect(mapCoverMovement("Rising")).toBe("opening");
        expect(mapCoverMovement("declining")).toBe("closing");
        expect(mapCoverMovement("paused")).toBe("stopped");
        expect(mapCoverMovement("wobbling")).toBeUndefined();
    });
});

describe("electrical unit conversion", () => {
    it("converts power and energy to Matter milli-units and rejects unknown units", () => {
        expect(toMatterElectrical("power", 1.5, "W")).toBe(1500);
        expect(toMatterElectrical("power", 2, "kW")).toBe(2_000_000);
        expect(toMatterElectrical("power", 7, "mW")).toBe(7);
        expect(toMatterElectrical("energy", 1.234, "kWh")).toBe(1_234_000);
        expect(toMatterElectrical("energy", 3, "Wh")).toBe(3000);
        expect(toMatterElectrical("voltage", 230.4, "V")).toBe(230_400);
        expect(toMatterElectrical("current", 0.25, "A")).toBe(250);
        expect(() => toMatterElectrical("power", 1, "VA")).toThrow("unsupported power unit");
        expect(() => toMatterElectrical("power", 1, undefined)).toThrow();
        expect(() => toMatterElectrical("current", 1, "kA")).toThrow();
        expect(() => toMatterElectrical("power", Number.NaN, "W")).toThrow();
        expect(() => toMatterElectrical("power", 1e300, "kW")).toThrow();
    });

    it("does not treat prototype keys as units", () => {
        expect(isKnownElectricalUnit("power", "constructor")).toBe(false);
        expect(isKnownElectricalUnit("power", "__proto__")).toBe(false);
        expect(isKnownElectricalUnit("power", "W")).toBe(true);
    });

    it("toWatts/toWattHours scale by the declared unit only", () => {
        expect(toWatts(1500, "mW")).toBeCloseTo(1.5);
        expect(toWatts(2, "kW")).toBe(2000);
        expect(toWattHours(2, "kWh")).toBe(2000);
        expect(() => toWatts(Number.POSITIVE_INFINITY, "W")).toThrow();
    });

    it("EnergyAccumulator flags a counter reset and rejects negative totals", () => {
        const acc = new EnergyAccumulator();
        expect(acc.observe({cumulativeWattHours: 100})).toEqual({value: 100, reset: false});
        expect(acc.observe({cumulativeWattHours: 150})).toEqual({value: 150, reset: false});
        expect(acc.observe({cumulativeWattHours: 5})).toEqual({value: 5, reset: true});
        expect(acc.observe({instantaneousWatts: 3})).toBeUndefined();
        expect(acc.lastCumulativeWattHours).toBe(5);
        expect(() => acc.observe({cumulativeWattHours: -1})).toThrow();
    });
});

describe("sensor mapping (occupancy/contact/temperature/humidity)", () => {
    it("occupancy uses OccupancySensing with a bitmap object and contact uses BooleanState", () => {
        expect(occupancyToMatter(true)).toEqual({occupied: true});
        expect(booleanSensorBySemantic("occupancy", true)).toEqual({
            known: true,
            value: {semantic: "occupancy", cluster: "OccupancySensing", value: true},
        });
        expect(booleanSensorBySemantic("contact", false, true)).toEqual({
            known: true,
            value: {semantic: "contact", cluster: "BooleanState", value: true},
        });
        expect(booleanSensorBySemantic("occupancy", null)).toEqual({known: false});
        expect(booleanSensorToMatter(undefined)).toEqual({known: false});
        expect(booleanSensorToMatter(true, true)).toEqual({known: true, value: false});
    });

    it("scales temperature/humidity to 0.01 units, keeps unknown unknown, clamps humidity and bounds temperature", () => {
        expect(celsiusToMatter(21.57)).toEqual({known: true, value: 2157});
        expect(celsiusToMatter(null)).toEqual({known: false});
        expect(() => celsiusToMatter(400)).toThrow();
        expect(() => celsiusToMatter(Number.NaN)).toThrow();
        expect(humidityPercentToMatter(55.5)).toEqual({known: true, value: 5550});
        expect(humidityPercentToMatter(100.3)).toEqual({known: true, value: 10000});
        expect(humidityPercentToMatter(-2)).toEqual({known: true, value: 0});
        expect(humidityPercentToMatter(undefined)).toEqual({known: false});
    });
});

describe("planEndpointMapping", () => {
    const temperature: MappingExpose = {type: "numeric", name: "temperature", unit: "°C", access: 1};
    const occupancy: MappingExpose = {type: "binary", name: "occupancy", access: 1};
    const power: MappingExpose = {type: "numeric", name: "power", unit: "W", access: 1};

    it("maps occupancy and temperature on the primary endpoint", () => {
        const plan = planEndpointMapping([temperature, occupancy]);
        expect(Object.keys(plan.capabilities).sort()).toEqual(["occupancy", "temperature"]);
        expect(plan.mappings.find((m) => m.ruleId === "occupancy")).toMatchObject({matterDeviceType: "OccupancySensor", supported: true});
    });

    it("non-primary endpoints do not receive unlabeled shared exposes, but keep endpoint-labeled ones", () => {
        const labeled: MappingExpose = {type: "binary", name: "contact", endpoint: "l2", access: 1};
        const primary = planEndpointMapping([temperature, power, labeled], {isPrimaryEndpoint: true});
        expect(Object.keys(primary.capabilities).sort()).toEqual(["contact", "power", "temperature"]);

        const secondary = planEndpointMapping([temperature, power, labeled], {isPrimaryEndpoint: false});
        expect(Object.keys(secondary.capabilities)).toEqual(["contact"]);
    });

    it("skips an electrical capability whose unit is unknown instead of guessing", () => {
        const plan = planEndpointMapping([{type: "numeric", name: "power", unit: "VA", access: 1}]);
        expect(plan.capabilities.power).toBeUndefined();
        expect(planEndpointMapping([{type: "numeric", name: "power", access: 1}]).capabilities.power).toBeUndefined();
    });

    it("derives buttons from the action enum and ignores brightness_move_up style values", () => {
        const action: MappingExpose = {
            type: "enum",
            name: "action",
            access: 1,
            values: ["1_single", "1_double", "2_hold", "brightness_move_up", "brightness_stop"],
        };
        const plan = planEndpointMapping([action]);
        expect(plan.capabilities.button).toBeDefined();
        expect(plan.buttons).toEqual(["1", "2"]);
    });

    it("returns no button list without an action enum", () => {
        expect(planEndpointMapping([temperature]).buttons).toEqual([]);
    });
});
