// biome-ignore assist/source/organizeImports: import mocks first
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import * as data from "../mocks/data";
import {mockLogger} from "../mocks/logger";
import {events as mockBridgeBusEvents, mockBridgeBusPublish} from "../mocks/bridgeBus";
import {flushPromises} from "../mocks/utils";
import {devices, groups, events as mockZHEvents, resetGroupMembers, returnDevices} from "../mocks/zigbeeHerdsman";

import {stringify} from "../../lib/util/stringify";
import * as zhcGlobalStore from "zigbee-herdsman-converters/lib/store";
import {Controller} from "../../lib/controller";
import * as settings from "../../lib/util/settings";

returnDevices.push(
    devices.coordinator.ieeeAddr,
    devices.bulb_color.ieeeAddr,
    devices.bulb.ieeeAddr,
    devices.QBKG03LM.ieeeAddr,
    devices.bulb_color_2.ieeeAddr,
    devices.bulb_2.ieeeAddr,
    devices.GLEDOPTO_2ID.ieeeAddr,
    devices.InovelliVZM31SN.ieeeAddr,
    devices.zigfred_plus.ieeeAddr,
);

describe("Extension: Groups", () => {
    let controller: Controller;

    beforeAll(async () => {
        vi.useFakeTimers();
        controller = new Controller(vi.fn(), vi.fn());
        await controller.start();
        await flushPromises();
    });

    afterAll(async () => {
        await controller?.stop();
        await flushPromises();
        vi.useRealTimers();
    });

    beforeEach(() => {
        resetGroupMembers();
        data.writeDefaultConfiguration();
        settings.reRead();
        mockBridgeBusPublish.mockClear();
        groups.gledopto_group.command.mockClear();
        zhcGlobalStore.clear();
        controller.state.clear();
    });

    it("Should publish group state change when a device in it changes state", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);

        mockBridgeBusPublish.mockClear();
        const payload = {data: {onOff: 1}, cluster: "genOnOff", device, endpoint, type: "attributeReport", linkquality: 10};
        await mockZHEvents.message(payload);
        await flushPromises();

        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
    });

    it("Should not republish identical optimistic group states", async () => {
        const device1 = devices.bulb_2;
        const device2 = devices.bulb_color_2;

        mockBridgeBusPublish.mockClear();
        await mockZHEvents.message({
            data: {onOff: 1},
            cluster: "genOnOff",
            device: device1,
            endpoint: device1.getEndpoint(1),
            type: "attributeReport",
            linkquality: 10,
        });
        await mockZHEvents.message({
            data: {onOff: 1},
            cluster: "genOnOff",
            device: device2,
            endpoint: device2.getEndpoint(1),
            type: "attributeReport",
            linkquality: 10,
        });
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(6);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_tradfri_remote", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_2", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color_2", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_with_tradfri", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/ha_discovery_group", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/switch_group", stringify({state: "ON"}), {retain: false});
    });

    it("Should publish state change of all members when a group changes its state", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
    });

    it("Should not publish state change when group changes state and device is disabled", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        settings.set(["devices", device.ieeeAddr, "disabled"], true);

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(1);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
    });

    it("Should publish state change for group when members state change", async () => {
        // Created for https://github.com/Koenkk/zigbee2mqtt/issues/5725
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
    });

    it("Should publish state of device with endpoint name", async () => {
        const group = groups.gledopto_group;

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/gledopto_group/set", stringify({state: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/GLEDOPTO_2ID", stringify({state_cct: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/gledopto_group", stringify({state: "ON"}), {retain: false});
        expect(group.command).toHaveBeenCalledTimes(1);
        expect(group.command).toHaveBeenCalledWith("genOnOff", "on", {}, {});
    });

    it("Should publish state of group when specific state of specific endpoint is changed", async () => {
        const group = groups.gledopto_group;

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/GLEDOPTO_2ID/set", stringify({state_cct: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/GLEDOPTO_2ID", stringify({state_cct: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/gledopto_group", stringify({state: "ON"}), {retain: false});
        expect(group.command).toHaveBeenCalledTimes(0);
    });

    it("Should publish state change of all members when a group changes its state, filtered", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        settings.set(["groups"], {1: {friendly_name: "group_1", retain: false, filtered_attributes: ["brightness"]}});

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON", brightness: 100}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON", brightness: 100}), {
            retain: false,
        });
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
    });

    it("Shouldnt publish group state change when a group is not optimistic", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        settings.set(["groups"], {1: {friendly_name: "group_1", optimistic: false, retain: false}});

        mockBridgeBusPublish.mockClear();
        const payload = {data: {onOff: 1}, cluster: "genOnOff", device, endpoint, type: "attributeReport", linkquality: 10};
        await mockZHEvents.message(payload);
        await flushPromises();

        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(1);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON"}), {retain: false});
    });

    it("Should publish state change of another group with shared device when a group changes its state", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        groups.group_1.members.push(endpoint);
        groups.group_2.members.push(endpoint);

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_2", stringify({state: "ON"}), {retain: false});
    });

    it("Should not publish state change off if any lights within are still on when changed via device", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.bulb;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(1);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
    });

    it("Should publish state change off if any lights within are still on when changed via device when off_state: last_member_state is used", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.bulb;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false, off_state: "last_member_state"},
        });

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenNthCalledWith(1, "zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenNthCalledWith(2, "zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
    });

    it("Should not publish state change off if any lights within with non default-ep are still on when changed via device", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.QBKG03LM;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(2)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(1);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
    });

    it("Should not publish state change off if any lights within are still on when changed via device with non default-ep", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.QBKG03LM;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(2)!;
        const endpoint_3 = device_2.getEndpoint(3)!;
        endpoint_3.removeFromGroup(groups.ha_discovery_group);
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        group.members.push(endpoint_3);

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/wall_switch_double/set", stringify({state_left: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(1);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/wall_switch_double", stringify({state_left: "OFF", state_right: "ON"}), {
            retain: false,
        });
    });

    it("Should publish state change off if all lights within turn off with non default-ep", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.QBKG03LM;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(2)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false},
        });

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await mockBridgeBusEvents.message("zigbee2matter/wall_switch_double/set", stringify({state_left: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/wall_switch_double", stringify({state_left: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
    });

    it("Should publish state change off if all lights within turn off with non default-ep, but device state does not use them", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.InovelliVZM31SN;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(2)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false},
        });

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await mockBridgeBusEvents.message("zigbee2matter/wall_switch_double/set", stringify({state_left: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/wall_switch_double", stringify({state_left: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
    });

    it.each([
        {name: "still on", l2: "ON", groupOff: false},
        {name: "off", l2: "OFF", groupOff: true},
    ])("Should check the state of the member endpoint by its name when its ID is not its position ($name)", async ({l2, groupOff}) => {
        // ZFP-1A-CH maps l2 to endpoint 7, so its state is state_l2, not state_<getEndpointNames()[7 - 1]>
        const device_1 = devices.bulb_color;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = devices.zigfred_plus.getEndpoint(7)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false},
        });
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        // @ts-expect-error private
        controller.state.set(controller.zigbee.resolveEntity(devices.zigfred_plus.ieeeAddr)!, {state_l2: l2});
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
        if (groupOff) {
            expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
        } else {
            expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
        }
    });

    it("Should not publish state change off if any lights within are still on when changed via shared group", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.bulb;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(1)!;
        groups.group_1.members.push(endpoint_1);
        groups.group_1.members.push(endpoint_2);
        groups.group_2.members.push(endpoint_1);

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/group_2/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_2", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
    });

    it("Should publish state change off if all lights within turn off", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.bulb;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false},
        });

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await mockBridgeBusEvents.message("zigbee2matter/bulb/set", stringify({state: "OFF"}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({state: "OFF"}), {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
    });

    it("Should only update group state with changed properties", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.bulb;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false},
        });
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF", color_temp: 200}));
        await mockBridgeBusEvents.message("zigbee2matter/bulb/set", stringify({state: "ON", color_temp: 250}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({color_temp: 300}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb_color",
            stringify({color_mode: "color_temp", color_temp: 300, state: "OFF"}),
            {retain: false},
        );
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({color_mode: "color_temp", color_temp: 300, state: "ON"}), {
            retain: true,
        });
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/group_1",
            stringify({color_mode: "color_temp", color_temp: 300, state: "ON"}),
            {retain: false},
        );
    });

    it("Should publish state change off even when missing current state", async () => {
        const device_1 = devices.bulb_color;
        const device_2 = devices.bulb;
        const endpoint_1 = device_1.getEndpoint(1)!;
        const endpoint_2 = device_2.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint_1);
        group.members.push(endpoint_2);
        settings.set(["groups"], {
            1: {friendly_name: "group_1", retain: false},
        });

        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({state: "ON"}));
        await flushPromises();
        mockBridgeBusPublish.mockClear();
        controller.state.clear();

        await mockBridgeBusEvents.message("zigbee2matter/bulb_color/set", stringify({state: "OFF"}));
        await flushPromises();

        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({state: "OFF"}), {retain: false});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "OFF"}), {retain: false});
    });

    it("Add to group via bridgeBus", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1);
        const group = groups.group_1;
        expect(group.members.length).toBe(0);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/add",
            stringify({transaction: "123", group: "group_1", device: "bulb_color"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([endpoint]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {device: "bulb_color", endpoint: "default", group: "group_1"}, transaction: "123", status: "ok"}),
            {},
        );
    });

    it("Add to group via bridgeBus fails", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        expect(group.members.length).toBe(0);
        endpoint.addToGroup.mockImplementationOnce(() => {
            throw new Error("timeout");
        });
        await flushPromises();
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message("zigbee2matter/bridge/request/group/members/add", stringify({group: "group_1", device: "bulb_color"}));
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {}, status: "error", error: "Failed to add to group (timeout)"}),
            {},
        );
    });

    it("Add to group with slashes via bridgeBus", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1);
        const group = groups["group/with/slashes"];
        settings.set(["groups"], {99: {friendly_name: "group/with/slashes", retain: false}});
        expect(group.members.length).toBe(0);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message("zigbee2matter/bridge/request/group/members/add", stringify({group: "group/with/slashes", device: "bulb_color"}));
        await flushPromises();
        expect(group.members).toStrictEqual([endpoint]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {device: "bulb_color", endpoint: "default", group: "group/with/slashes"}, status: "ok"}),
            {},
        );
    });

    it("Add to group via bridgeBus with postfix", async () => {
        const device = devices.QBKG03LM;
        const endpoint = device.getEndpoint(3)!;
        const group = groups.group_1;
        expect(group.members.length).toBe(0);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/add",
            stringify({group: "group_1", device: "wall_switch_double", endpoint: "right"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([endpoint]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {device: "wall_switch_double", endpoint: "right", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Add to group via bridgeBus with postfix shouldnt add it twice", async () => {
        const device = devices.QBKG03LM;
        const endpoint = device.getEndpoint(3)!;
        const group = groups.group_1;
        expect(group.members.length).toBe(0);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/add",
            stringify({group: "group_1", device: "wall_switch_double", endpoint: "right"}),
        );
        await flushPromises();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/add",
            stringify({group: "group_1", device: "0x0017880104e45542", endpoint: "3"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([endpoint]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {device: "wall_switch_double", endpoint: "right", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Remove from group via bridgeBus", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message("zigbee2matter/bridge/request/group/members/remove", stringify({group: "group_1", device: "bulb_color"}));
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {device: "bulb_color", endpoint: "default", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Remove from group via bridgeBus fails", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        endpoint.removeFromGroup.mockImplementationOnce(() => {
            throw new Error("timeout");
        });
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message("zigbee2matter/bridge/request/group/members/remove", stringify({group: "group_1", device: "bulb_color"}));
        await flushPromises();
        expect(group.members.length).toStrictEqual(1);
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {}, status: "error", error: "Failed to remove from group (timeout)"}),
            {},
        );
    });

    it("Remove from group via bridgeBus keeping device reporting", async () => {
        const device = devices.bulb_color;
        const endpoint = device.getEndpoint(1)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/remove",
            stringify({group: "group_1", device: "bulb_color", skip_disable_reporting: true}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {device: "bulb_color", endpoint: "default", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Remove from group via bridgeBus with postfix variant 1", async () => {
        const device = devices.QBKG03LM;
        const endpoint = device.getEndpoint(3)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/remove",
            stringify({group: "group_1", device: "0x0017880104e45542", endpoint: "3"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {device: "0x0017880104e45542", endpoint: "3", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Remove from group via bridgeBus with postfix variant 2", async () => {
        const device = devices.QBKG03LM;
        const endpoint = device.getEndpoint(3)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/remove",
            stringify({group: "group_1", device: "wall_switch_double", endpoint: "3"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {device: "wall_switch_double", endpoint: "3", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Remove from group via bridgeBus with postfix variant 3", async () => {
        const device = devices.QBKG03LM;
        const endpoint = device.getEndpoint(3)!;
        const group = groups.group_1;
        group.members.push(endpoint);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/remove",
            stringify({group: "group_1", device: "0x0017880104e45542", endpoint: "right"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {device: "0x0017880104e45542", endpoint: "right", group: "group_1"}, status: "ok"}),
            {},
        );
    });

    it("Remove from group all", async () => {
        const group = groups.group_1;
        groups.group_1.members.push(devices.QBKG03LM.endpoints[2]);
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/remove_all",
            stringify({device: "0x0017880104e45542", endpoint: "right"}),
        );
        await flushPromises();
        expect(group.members).toStrictEqual([]);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove_all",
            stringify({data: {device: "0x0017880104e45542", endpoint: "right"}, status: "ok"}),
            {},
        );
    });

    it("Error when adding to non-existing group", async () => {
        mockLogger.error.mockClear();
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/remove",
            stringify({group: "group_1_not_existing", device: "bulb_color"}),
        );
        await flushPromises();
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/remove",
            stringify({data: {}, status: "error", error: "Group 'group_1_not_existing' does not exist"}),
            {},
        );
    });

    it("Error when adding a non-existing device", async () => {
        mockLogger.error.mockClear();
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/add",
            stringify({group: "group_1", device: "bulb_color_not_existing"}),
        );
        await flushPromises();
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {}, status: "error", error: "Device 'bulb_color_not_existing' does not exist"}),
            {},
        );
    });

    it("Error when adding a non-existing endpoint", async () => {
        mockLogger.error.mockClear();
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message(
            "zigbee2matter/bridge/request/group/members/add",
            stringify({group: "group_1", device: "bulb_color", endpoint: "not_existing_endpoint"}),
        );
        await flushPromises();
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {}, status: "error", error: "Device 'bulb_color' does not have endpoint 'not_existing_endpoint'"}),
            {},
        );
    });

    it("Error when invalid payload", async () => {
        mockLogger.error.mockClear();
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message("zigbee2matter/bridge/request/group/members/add", stringify({group: "group_1", devicez: "bulb_color"}));
        await flushPromises();
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {}, status: "error", error: "Invalid payload"}),
            {},
        );
    });

    it("Error when add/remove with invalid payload", async () => {
        mockLogger.error.mockClear();
        mockBridgeBusPublish.mockClear();
        mockBridgeBusEvents.message("zigbee2matter/bridge/request/group/members/add", stringify({groupz: "group_1", device: "bulb_color"}));
        await flushPromises();
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/bridge/groups", expect.any(String), expect.any(Object));
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/response/group/members/add",
            stringify({data: {}, status: "error", error: "Invalid payload"}),
            {},
        );
    });

    it("Should only include relevant properties when publishing member states", async () => {
        const bulbColor = devices.bulb_color;
        const bulbColorTemp = devices.bulb;
        const group = groups.group_1;
        group.members.push(bulbColor.getEndpoint(1)!);
        group.members.push(bulbColorTemp.getEndpoint(1)!);

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({color_temp: 50}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb_color", stringify({color_mode: "color_temp", color_temp: 50}), {
            retain: false,
        });
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({color_mode: "color_temp", color_temp: 50}), {
            retain: false,
        });
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({color_mode: "color_temp", color_temp: 50}), {
            retain: true,
        });

        mockBridgeBusPublish.mockClear();
        await mockBridgeBusEvents.message("zigbee2matter/group_1/set", stringify({color: {x: 0.5, y: 0.3}}));
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb_color",
            stringify({color: {x: 0.5, y: 0.3}, color_mode: "xy", color_temp: 548}),
            {retain: false},
        );
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/group_1",
            stringify({color: {x: 0.5, y: 0.3}, color_mode: "xy", color_temp: 548}),
            {retain: false},
        );
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({color_mode: "color_temp", color_temp: 548}), {
            retain: true,
        });
    });
});
