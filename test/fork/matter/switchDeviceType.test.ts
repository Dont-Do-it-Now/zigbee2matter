// z2m-fork: precedence of the Matter on/off switch device type: device option > light capability > light-switch description > outlet.
import {describe, expect, it} from "vitest";
import "../../mocks/data";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import Matter from "../../../lib/extension/matter";

const {presets: e} = exposes;

function typeFor(description: string, options: Record<string, unknown>, expose: unknown): string {
    const self = {
        endpointExposes: () => [expose],
        matterDeviceName: () => "device",
        state: {get: () => ({})},
        matterVendorId: 0xfff1,
    };
    const device = {
        name: "device",
        definition: {description},
        options,
        zh: {endpoints: [{ID: 1}]},
    };
    const matterSourceFor = (Matter.prototype as unknown as Record<string, (...args: unknown[]) => {switchDeviceType: string}>).matterSourceFor;

    return matterSourceFor.call(self, device, {ID: 1}, {endpointId: "z2m-1", key: "k"}).switchDeviceType;
}

describe("matterSourceFor switchDeviceType precedence", () => {
    const plainSwitch = e.switch();

    it("treats a light-switch description as a light and a plain switch as an outlet", () => {
        expect(typeFor("Smart light switch - 3 gang", {}, plainSwitch)).toBe("OnOffLight");
        expect(typeFor("Smart plug", {}, plainSwitch)).toBe("OnOffPlugInUnit");
    });

    it("device option outlet overrides a light-switch description", () => {
        expect(typeFor("Smart light switch - 3 gang", {matter_device_type: "outlet"}, plainSwitch)).toBe("OnOffPlugInUnit");
    });

    it("device option light forces a plug to a light", () => {
        expect(typeFor("Smart plug", {matter_device_type: "light"}, plainSwitch)).toBe("OnOffLight");
    });
});
