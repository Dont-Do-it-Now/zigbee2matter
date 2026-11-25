// biome-ignore assist/source/organizeImports: import mocks first
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import * as data from "./mocks/data";
import {mockLogger} from "./mocks/logger";
import {events as mockBridgeBusEvents, mockBridgeBusPublish} from "./mocks/bridgeBus";
import {flushPromises} from "./mocks/utils";
import type {Device as ZhDevice} from "./mocks/zigbeeHerdsman";
import {devices, mockController as mockZHController, events as mockZHEvents, returnDevices} from "./mocks/zigbeeHerdsman";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {stringify} from "../lib/util/stringify";
import type {Mock, MockInstance} from "vitest";
import {Controller as ZHController} from "zigbee-herdsman";
import {Controller} from "../lib/controller";
import type Device from "../lib/model/device";
import * as settings from "../lib/util/settings";
import Frontend from "../lib/extension/frontend";

const LOG_BRIDGE_BUS_NS = "z2m:bridgeBus";

const mockUnixDgramSend = vi.fn();

vi.mock("unix-dgram", () => ({
    createSocket: vi.fn(() => ({send: mockUnixDgramSend})),
}));

const mocksClear = [
    mockZHController.stop,
    mockBridgeBusPublish,
    devices.bulb_color.removeFromNetwork,
    devices.bulb.removeFromNetwork,
    mockLogger.log,
    mockLogger.debug,
    mockLogger.info,
    mockLogger.error,
    mockUnixDgramSend,
];

describe("Controller", () => {
    let controller: Controller;
    let mockExit: Mock;
    let stopAfter = true;

    const getZ2MDevice = (zhDevice: string | number | ZhDevice): Device => {
        return controller.zigbee.resolveEntity(zhDevice)! as Device;
    };

    beforeAll(() => {
        vi.useFakeTimers();
    });

    beforeEach(() => {
        stopAfter = true;
        returnDevices.splice(0);
        mockExit = vi.fn();
        data.writeDefaultConfiguration();
        settings.reRead();
        controller = new Controller(vi.fn(), mockExit);
        for (const mock of mocksClear) mock.mockClear();
        settings.reRead();
        data.writeDefaultState();
    });

    afterAll(() => {
        vi.useRealTimers();
    });

    afterEach(async () => {
        if (stopAfter) {
            await controller?.stop();
        }

        await flushPromises();
    });

    it("Start controller", async () => {
        settings.setOnboarding(true);
        settings.set(["advanced", "transmit_power"], 14);
        await controller.start();
        expect(ZHController).toHaveBeenCalledWith({
            network: {
                panID: 6754,
                extendedPanID: [221, 221, 221, 221, 221, 221, 221, 221],
                channelList: [11],
                networkKey: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13],
            },
            databasePath: path.join(data.mockDir, "database.db"),
            databaseBackupPath: path.join(data.mockDir, "database.db.backup"),
            backupPath: path.join(data.mockDir, "coordinator_backup.json"),
            acceptJoiningDeviceHandler: expect.any(Function),
            adapter: {concurrent: undefined, delay: undefined, disableLED: false, transmitPower: 14},
            transport: {baudRate: undefined, rtscts: undefined, path: "/dev/dummy"},
        });
        expect(mockZHController.start).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith(`Currently ${Object.values(devices).length - 1} devices are joined.`);
        expect(mockLogger.info).toHaveBeenCalledWith(
            "bulb (0x000b57fffec6a5b2): LED1545G12 - IKEA TRADFRI bulb E26/E27, white spectrum, globe, opal, 980 lm (Router)",
        );
        expect(mockLogger.info).toHaveBeenCalledWith("remote (0x0017880104e45517): 324131092621 - Philips Hue dimmer switch gen 1 (EndDevice)");
        expect(mockLogger.info).toHaveBeenCalledWith("0x0017880104e45518 (0x0017880104e45518): Not supported (EndDevice)");
        expect(controller.bridgeBus.isConnected()).toStrictEqual(true);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/state", stringify({state: "online"}), {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 50, color_temp: 370, linkquality: 99}),
            {retain: true},
        );
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/remote", stringify({brightness: 255}), {retain: true});
        expect(settings.get().onboarding).toBeUndefined();
    });

    it("Should generate network_key, pan_id and ext_pan_id when set to GENERATE", async () => {
        settings.set(["advanced", "network_key"], "GENERATE");
        settings.set(["advanced", "pan_id"], "GENERATE");
        settings.set(["advanced", "ext_pan_id"], "GENERATE");
        await controller.start();
        await flushPromises();
        expect((ZHController as unknown as MockInstance).mock.calls[0][0].network.networkKey.length).toStrictEqual(16);
        expect((ZHController as unknown as MockInstance).mock.calls[0][0].network.extendedPanID.length).toStrictEqual(8);
        expect((ZHController as unknown as MockInstance).mock.calls[0][0].network.panID).toStrictEqual(expect.any(Number));
        expect(data.read().advanced.network_key.length).toStrictEqual(16);
        expect(data.read().advanced.ext_pan_id.length).toStrictEqual(8);
        expect(data.read().advanced.pan_id).toStrictEqual(expect.any(Number));
    });

    it("Start controller should publish cached states", async () => {
        data.writeDefaultState();
        await controller.start();
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 50, color_temp: 370, linkquality: 99}),
            {retain: true},
        );
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/remote", stringify({brightness: 255}), {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/group_1", stringify({state: "ON"}), {retain: false});
    });

    it("Start controller should not publish cached states when disabled", async () => {
        settings.set(["advanced", "cache_state_send_on_startup"], false);
        data.writeDefaultState();
        await controller.start();
        await flushPromises();
        const publishedTopics = mockBridgeBusPublish.mock.calls.map((m) => m[0]);
        expect(publishedTopics).toEqual(expect.not.arrayContaining(["zigbee2matter/bulb", "zigbee2matter/remote"]));
    });

    it("Start controller should not publish cached states when cache_state is false", async () => {
        settings.set(["advanced", "cache_state"], false);
        data.writeDefaultState();
        await controller.start();
        await flushPromises();
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            `{"state":"ON","brightness":50,"color_temp":370,"linkquality":99}`,
            {retain: true},
        );
        expect(mockBridgeBusPublish).not.toHaveBeenCalledWith("zigbee2matter/remote", `{"brightness":255}`, {retain: true});
    });

    it("Should not allow publishing wildcard characters in topic", async () => {
        await controller.start();
        await flushPromises();
        mockBridgeBusPublish.mockClear();
        await controller.bridgeBus.publish("z2m/#/status", "empty");
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(0);
        expect(mockLogger.error).toHaveBeenCalledWith(`Topic 'z2m/#/status' includes wildcard characters, skipping publish.`);
        await controller.bridgeBus.publish("z2m/+/status", "empty");
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(0);
        expect(mockLogger.error).toHaveBeenCalledWith(`Topic 'z2m/+/status' includes wildcard characters, skipping publish.`);
    });

    it("Load empty state when state file does not exist", async () => {
        data.removeState();
        await controller.start();
        await flushPromises();
        // @ts-expect-error private
        expect(controller.state.state).toStrictEqual(new Map());
    });

    it("Should remove device not on passlist on startup", async () => {
        settings.set(["passlist"], [devices.bulb_color.ieeeAddr]);
        devices.bulb.removeFromNetwork.mockImplementationOnce(() => {
            throw new Error("dummy");
        });
        await controller.start();
        await flushPromises();
        expect(devices.bulb_color.removeFromNetwork).toHaveBeenCalledTimes(0);
        expect(devices.bulb.removeFromNetwork).toHaveBeenCalledTimes(1);
    });

    it("Should remove device on blocklist on startup", async () => {
        settings.set(["blocklist"], [devices.bulb_color.ieeeAddr, "0x9998889998889990", "0x00124b00120144ae"]);
        await controller.start();
        await flushPromises();
        expect(devices.bulb_color.removeFromNetwork).toHaveBeenCalledTimes(1);
        expect(devices.bulb.removeFromNetwork).toHaveBeenCalledTimes(0);
        expect(devices.coordinator.removeFromNetwork).toHaveBeenCalledTimes(0);
        const debugCalls = mockLogger.debug.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : c[0]()));
        expect(debugCalls.find((v) => v === "Ignoring blocklist device 0x9998889998889990, not currently on the network")).toBeDefined();
    });

    it("Start controller fails", async () => {
        mockZHController.start.mockImplementationOnce(() => {
            throw new Error("failed");
        });
        await controller.start();
        expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it("Start controller fails after onboarding", async () => {
        settings.setOnboarding(true);
        mockZHController.start.mockImplementationOnce(() => {
            throw new Error("failed");
        });
        await controller.start();
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(settings.get().onboarding).toStrictEqual(true);
    });

    it("Start controller fails due to BridgeBus connect error", async () => {
        // biome-ignore lint/suspicious/useAwait: mock throws synchronously via async wrapper
        vi.spyOn(controller.bridgeBus, "connect").mockImplementationOnce(async () => {
            throw new Error("addr not found");
        });
        await controller.start();
        await flushPromises();
        expect(mockLogger.error).toHaveBeenCalledWith("BridgeBus failed to connect, exiting... (addr not found)");
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(1, false);
    });

    it("Start controller fails due to BridgeBus connect error after onboarding", async () => {
        settings.setOnboarding(true);
        // biome-ignore lint/suspicious/useAwait: mock throws synchronously via async wrapper
        vi.spyOn(controller.bridgeBus, "connect").mockImplementationOnce(async () => {
            throw new Error("addr not found");
        });
        await controller.start();
        await flushPromises();
        expect(mockLogger.error).toHaveBeenCalledWith("BridgeBus failed to connect, exiting... (addr not found)");
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(1, false);
        expect(settings.get().onboarding).toStrictEqual(true);
    });

    it("Start controller and stop with restart", async () => {
        await controller.start();
        await controller.stop(true);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/state", stringify({state: "offline"}), {retain: true});
        expect(mockZHController.stop).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(0, true);
    });

    it("Start controller and stop without SdNotify", async () => {
        mockZHController.stop.mockRejectedValueOnce("failed");
        await controller.start();
        await controller.stop();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/state", stringify({state: "offline"}), {retain: true});
        expect(mockZHController.stop).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(1, false);
        expect(mockUnixDgramSend).toHaveBeenCalledTimes(0);
    });

    it("Start controller and stop with SdNotify", async () => {
        vi.spyOn(os, "platform").mockImplementationOnce(() => "linux");

        process.env.NOTIFY_SOCKET = "mocked"; // coverage

        mockZHController.stop.mockRejectedValueOnce("failed");
        await controller.start();
        await controller.stop();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/state", stringify({state: "offline"}), {retain: true});
        expect(mockZHController.stop).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(1, false);
        expect(mockUnixDgramSend).toHaveBeenCalledTimes(2);

        delete process.env.NOTIFY_SOCKET;
    });

    describe("aborts during startup", () => {
        let stateStartSpy: MockInstance<() => void>;
        let zigbeeStartSpy: MockInstance<() => Promise<boolean>>;
        let bridgeBusConnectSpy: MockInstance<() => Promise<void>>;
        let extensionStartSpy: MockInstance<() => Promise<void>>;
        let publishEntityStateSpy: MockInstance<() => Promise<void>>;
        let extensionStopSpy: MockInstance<() => Promise<void>>;
        let bridgeBusDisconnectSpy: MockInstance<() => Promise<void>>;
        let bridgeBusPublishSpy: MockInstance<() => Promise<void>>;

        beforeEach(() => {
            stateStartSpy = vi.spyOn(controller.state, "start");
            zigbeeStartSpy = vi.spyOn(controller.zigbee, "start");
            bridgeBusConnectSpy = vi.spyOn(controller.bridgeBus, "connect");
            const [firstExt] = controller.extensions;
            extensionStartSpy = vi.spyOn(firstExt, "start");
            publishEntityStateSpy = vi.spyOn(controller, "publishEntityState");
            extensionStopSpy = vi.spyOn(firstExt, "stop");
            bridgeBusDisconnectSpy = vi.spyOn(controller.bridgeBus, "disconnect");
            bridgeBusPublishSpy = vi.spyOn(controller.bridgeBus, "publish");
        });

        afterEach(() => {
            stopAfter = false;
            stateStartSpy.mockRestore();
            zigbeeStartSpy.mockRestore();
            bridgeBusConnectSpy.mockRestore();
            extensionStartSpy.mockRestore();
            publishEntityStateSpy.mockRestore();
            extensionStopSpy.mockRestore();
            bridgeBusDisconnectSpy.mockRestore();
            bridgeBusPublishSpy.mockRestore();
        });

        it("during state start", async () => {
            stateStartSpy.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(0);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during zigbee resolve definitions", async () => {
            const resolveDevicesDefinitionsSpy = vi.spyOn(controller.zigbee, "resolveDevicesDefinitions");
            resolveDevicesDefinitionsSpy.mockImplementationOnce(async (ignoreCache, abortSignal) => {
                const device = controller.zigbee.resolveEntity(devices.bulb)! as Device;
                device.resolveDefinition = vi.fn(async () => {
                    await controller.stop(undefined, undefined, "SIGINT");
                });

                return await controller.zigbee.resolveDevicesDefinitions(ignoreCache, abortSignal);
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during BridgeBus connect", async () => {
            bridgeBusConnectSpy.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(1);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during extension start", async () => {
            extensionStartSpy.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(1);
            expect(extensionStartSpy).toHaveBeenCalledTimes(1);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(2);
        });

        it("during entity state publish", async () => {
            publishEntityStateSpy.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(1);
            expect(extensionStartSpy).toHaveBeenCalledTimes(1);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(1);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(12);
        });

        it("without signal during state start", async () => {
            stateStartSpy.mockImplementationOnce(async () => {
                await controller.stop();
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(0);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("without signal during BridgeBus connect", async () => {
            bridgeBusConnectSpy.mockImplementationOnce(async () => {
                await controller.stop();
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(1);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during ZH Controller start", async () => {
            mockZHController.start.mockImplementationOnce(async (abortSignal) => {
                void controller.stop(undefined, undefined, "SIGINT");
                abortSignal?.throwIfAborted();

                return await Promise.resolve("resumed");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during ZH Controller getNetworkParameters", async () => {
            mockZHController.getNetworkParameters.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");

                return await Promise.resolve({panID: 0x162a, extendedPanID: "0x64c5fd698daf0c00", channel: 15, nwkUpdateID: 0});
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during ZH Controller passlist", async () => {
            settings.set(["passlist"], [devices.bulb_color.ieeeAddr]);
            devices.bulb.removeFromNetwork.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });

        it("during ZH Controller blocklist", async () => {
            settings.set(["blocklist"], [devices.bulb_color.ieeeAddr]);
            devices.bulb_color.removeFromNetwork.mockImplementationOnce(async () => {
                await controller.stop(undefined, undefined, "SIGINT");
            });

            await controller.start();
            await flushPromises();

            expect(stateStartSpy).toHaveBeenCalledTimes(1);
            expect(zigbeeStartSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusConnectSpy).toHaveBeenCalledTimes(0);
            expect(extensionStartSpy).toHaveBeenCalledTimes(0);
            expect(publishEntityStateSpy).toHaveBeenCalledTimes(0);
            expect(extensionStopSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusDisconnectSpy).toHaveBeenCalledTimes(1);
            expect(bridgeBusPublishSpy).toHaveBeenCalledTimes(0);
        });
    });

    it("Start controller adapter disconnects", async () => {
        // Fail to stop extension exit code 1 should not override adapter disconnect exit code 2
        vi.spyOn(Array.from(controller.extensions)[0], "stop").mockRejectedValueOnce(new Error("failed"));
        await controller.start();
        await mockZHEvents.adapterDisconnected();
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/state", stringify({state: "offline"}), {retain: true});
        expect(mockZHController.stop).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(2, false);
    });

    it("does not throw when extension fails to stop on controller stop", async () => {
        vi.spyOn(Array.from(controller.extensions)[0], "stop").mockRejectedValueOnce(new Error("failed"));
        await controller.start();
        await flushPromises();
        await controller.stop();
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bridge/state", stringify({state: "offline"}), {retain: true});
        expect(mockExit).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(1, false);
    });

    it("does not throw when extension stop throws", async () => {
        const ext = Array.from(controller.extensions)[0];
        vi.spyOn(ext, "stop").mockRejectedValueOnce(new Error("failed"));
        await controller.start();
        await flushPromises();
        await controller.removeExtension(ext);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to stop"));
    });

    it("Handle bridgeBus message", async () => {
        const spyEventbusEmitBridgeBusMessage = vi.spyOn(controller.eventBus, "emitBridgeBusMessage").mockImplementation(vi.fn());

        await controller.start();
        mockLogger.debug.mockClear();
        await mockBridgeBusEvents.message("dummytopic", "dummymessage");
        expect(spyEventbusEmitBridgeBusMessage).toHaveBeenCalledWith({topic: "dummytopic", message: "dummymessage"});
        expect(mockLogger.log).toHaveBeenCalledWith("debug", "Received message on 'dummytopic' with data 'dummymessage'", LOG_BRIDGE_BUS_NS);
    });

    it("On zigbee event message", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {
            device,
            endpoint: device.getEndpoint(1),
            type: "attributeReport",
            linkquality: 10,
            cluster: "genBasic",
            data: {modelId: device.modelID},
        };
        await mockZHEvents.message(payload);
        await flushPromises();
        expect(mockLogger.log).toHaveBeenCalledWith(
            "debug",
            `Received Zigbee message from 'bulb', type 'attributeReport', cluster 'genBasic', data '{"modelId":"TRADFRI bulb E27 WS opal 980lm"}' from endpoint 1`,
            "z2m",
        );
    });

    it("On zigbee event message with group ID", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {
            device,
            endpoint: device.getEndpoint(1),
            type: "attributeReport",
            linkquality: 10,
            groupID: 0,
            cluster: "genBasic",
            data: {modelId: device.modelID},
        };
        await mockZHEvents.message(payload);
        await flushPromises();
        expect(mockLogger.log).toHaveBeenCalledWith(
            "debug",
            `Received Zigbee message from 'bulb', type 'attributeReport', cluster 'genBasic', data '{"modelId":"TRADFRI bulb E27 WS opal 980lm"}' from endpoint 1 with groupID 0`,
            "z2m",
        );
    });

    it("Should add entities which are missing from configuration but are in database to configuration", async () => {
        await controller.start();
        const device = devices.notInSettings;
        expect(settings.getDevice(device.ieeeAddr)).not.toBeUndefined();
    });

    it("On zigbee deviceJoined", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {device};
        await mockZHEvents.deviceJoined(payload);
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_joined", data: {friendly_name: "bulb", ieee_address: device.ieeeAddr}}),
            {retain: false},
        );
    });

    it("acceptJoiningDeviceHandler reject device on blocklist", async () => {
        await controller.start();
        const device = devices.bulb;
        settings.set(["blocklist"], [device.ieeeAddr]);
        const handler = (ZHController as unknown as MockInstance).mock.calls[0][0].acceptJoiningDeviceHandler;
        expect(await handler(device.ieeeAddr)).toBe(false);
    });

    it("acceptJoiningDeviceHandler accept device not on blocklist", async () => {
        await controller.start();
        const device = devices.bulb;
        settings.set(["blocklist"], ["123"]);
        const handler = (ZHController as unknown as MockInstance).mock.calls[0][0].acceptJoiningDeviceHandler;
        expect(await handler(device.ieeeAddr)).toBe(true);
    });

    it("acceptJoiningDeviceHandler accept device on passlist", async () => {
        await controller.start();
        const device = devices.bulb;
        settings.set(["passlist"], [device.ieeeAddr]);
        const handler = (ZHController as unknown as MockInstance).mock.calls[0][0].acceptJoiningDeviceHandler;
        expect(await handler(device.ieeeAddr)).toBe(true);
    });

    it("acceptJoiningDeviceHandler reject device not in passlist", async () => {
        await controller.start();
        const device = devices.bulb;
        settings.set(["passlist"], ["123"]);
        const handler = (ZHController as unknown as MockInstance).mock.calls[0][0].acceptJoiningDeviceHandler;
        expect(await handler(device.ieeeAddr)).toBe(false);
    });

    it("acceptJoiningDeviceHandler should prefer passlist above blocklist", async () => {
        await controller.start();
        const device = devices.bulb;
        settings.set(["passlist"], [device.ieeeAddr]);
        settings.set(["blocklist"], [device.ieeeAddr]);
        const handler = (ZHController as unknown as MockInstance).mock.calls[0][0].acceptJoiningDeviceHandler;
        expect(await handler(device.ieeeAddr)).toBe(true);
    });

    it("acceptJoiningDeviceHandler accept when not on blocklist and passlist", async () => {
        await controller.start();
        const device = devices.bulb;
        const handler = (ZHController as unknown as MockInstance).mock.calls[0][0].acceptJoiningDeviceHandler;
        expect(await handler(device.ieeeAddr)).toBe(true);
    });

    it("Shouldnt crash when two device join events are received", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {device};
        mockZHEvents.deviceJoined(payload);
        mockZHEvents.deviceJoined(payload);
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_joined", data: {friendly_name: "bulb", ieee_address: device.ieeeAddr}}),
            {retain: false},
        );
    });

    it("On zigbee deviceInterview started", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {device, status: "started"};
        await mockZHEvents.deviceInterview(payload);
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_interview", data: {friendly_name: "bulb", status: "started", ieee_address: device.ieeeAddr}}),
            {retain: false},
        );
    });

    it("On zigbee deviceInterview failed", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {device, status: "failed"};
        await mockZHEvents.deviceInterview(payload);
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_interview", data: {friendly_name: "bulb", status: "failed", ieee_address: device.ieeeAddr}}),
            {retain: false},
        );
    });

    it("On zigbee deviceInterview successful supported", async () => {
        await controller.start();
        mockBridgeBusPublish.mockClear();
        const device = devices.bulb;
        const payload = {device, status: "successful"};
        await mockZHEvents.deviceInterview(payload);
        await flushPromises();
        const eventCall = mockBridgeBusPublish.mock.calls.find(([topic]) => topic === "zigbee2matter/bridge/event");
        expect(eventCall?.[0]).toStrictEqual("zigbee2matter/bridge/event");
        const parsedMessage = JSON.parse(eventCall?.[1] ?? "{}");
        expect(parsedMessage.type).toStrictEqual("device_interview");
        expect(parsedMessage.data.friendly_name).toStrictEqual("bulb");
        expect(parsedMessage.data.status).toStrictEqual("successful");
        expect(parsedMessage.data.ieee_address).toStrictEqual(device.ieeeAddr);
        expect(parsedMessage.data.supported).toStrictEqual(true);
        expect(parsedMessage.data.definition.model).toStrictEqual("LED1545G12");
        expect(parsedMessage.data.definition.vendor).toStrictEqual("IKEA");
        expect(parsedMessage.data.definition.description).toStrictEqual("TRADFRI bulb E26/E27, white spectrum, globe, opal, 980 lm");
        expect(parsedMessage.data.definition.exposes).toStrictEqual(expect.any(Array));
        expect(parsedMessage.data.definition.options).toStrictEqual(expect.any(Array));
        expect(eventCall?.[2]).toStrictEqual({retain: false});
    });

    it("On zigbee deviceInterview successful not supported", async () => {
        await controller.start();
        mockBridgeBusPublish.mockClear();
        const device = devices.unsupported;
        const payload = {device, status: "successful"};
        await mockZHEvents.deviceInterview(payload);
        await flushPromises();
        const eventCall = mockBridgeBusPublish.mock.calls.find(([topic]) => topic === "zigbee2matter/bridge/event");
        expect(eventCall?.[0]).toStrictEqual("zigbee2matter/bridge/event");
        const parsedMessage = JSON.parse(eventCall?.[1] ?? "{}");
        expect(parsedMessage.type).toStrictEqual("device_interview");
        expect(parsedMessage.data.friendly_name).toStrictEqual(device.ieeeAddr);
        expect(parsedMessage.data.status).toStrictEqual("successful");
        expect(parsedMessage.data.ieee_address).toStrictEqual(device.ieeeAddr);
        expect(parsedMessage.data.supported).toStrictEqual(false);
        expect(parsedMessage.data.definition.model).toStrictEqual("notSupportedModelID");
        expect(parsedMessage.data.definition.vendor).toStrictEqual("notSupportedMfg");
        expect(parsedMessage.data.definition.description).toStrictEqual("Automatically generated definition");
        expect(parsedMessage.data.definition.exposes).toStrictEqual(expect.any(Array));
        expect(parsedMessage.data.definition.options).toStrictEqual(expect.any(Array));
        expect(eventCall?.[2]).toStrictEqual({retain: false});
    });

    it("On zigbee event device announce", async () => {
        await controller.start();
        const device = devices.bulb;
        const payload = {device};
        await mockZHEvents.deviceAnnounce(payload);
        await flushPromises();
        expect(mockLogger.debug).toHaveBeenCalledWith(`Device 'bulb' announced itself`);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_announce", data: {friendly_name: "bulb", ieee_address: device.ieeeAddr}}),
            {retain: false},
        );
    });

    it("On zigbee event device leave (removed from database and settings)", async () => {
        await controller.start();
        returnDevices.push("0x00124b00120144ae");
        settings.set(["devices"], {});
        mockBridgeBusPublish.mockClear();
        const device = devices.bulb;
        const payload = {ieeeAddr: device.ieeeAddr};
        await mockZHEvents.deviceLeave(payload);
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_leave", data: {ieee_address: device.ieeeAddr, friendly_name: device.ieeeAddr}}),
            {retain: false},
        );
    });

    it("On zigbee event device leave (removed from database and NOT settings)", async () => {
        await controller.start();
        returnDevices.push("0x00124b00120144ae");
        const device = devices.bulb;
        mockBridgeBusPublish.mockClear();
        const payload = {ieeeAddr: device.ieeeAddr};
        await mockZHEvents.deviceLeave(payload);
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bridge/event",
            stringify({type: "device_leave", data: {ieee_address: device.ieeeAddr, friendly_name: "bulb"}}),
            {retain: false},
        );
    });

    it("Publish entity state attribute output", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute");
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {
            dummy: {1: "yes", 2: "no"},
            color: {r: 100, g: 50, b: 10},
            state: "ON",
            test: undefined,
            test1: null,
            color_temp: 370,
            brightness: 50,
        });
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/brightness", "50", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/color_temp", "370", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/color", "100,50,10", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/dummy-1", "yes", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/dummy-2", "no", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/test1", "", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/test", "", {retain: true});
    });

    it("Publish entity state attribute_json output", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute_and_json");
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON", brightness: 200, color_temp: 370, linkquality: 99});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(5);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/brightness", "200", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/color_temp", "370", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/linkquality", "99", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 200, color_temp: 370, linkquality: 99}),
            {retain: true},
        );
    });

    it("Publish entity state attribute output with a null color", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute_and_json");
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON", color: null});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/color", "", {retain: true});
    });

    it("Publish entity state attribute_json output filtered", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute_and_json");
        settings.set(["devices", devices.bulb.ieeeAddr, "filtered_attributes"], ["color_temp", "linkquality"]);
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON", brightness: 200, color_temp: 370, linkquality: 99});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/brightness", "200", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({state: "ON", brightness: 200}), {retain: true});
    });

    it("Publish entity state attribute_json output filtered (device_options)", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute_and_json");
        settings.set(["device_options", "filtered_attributes"], ["color_temp", "linkquality"]);
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON", brightness: 200, color_temp: 370, linkquality: 99});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(3);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/brightness", "200", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({state: "ON", brightness: 200}), {retain: true});
    });

    it("Publish entity state caches a duration reported by the device", async () => {
        await controller.start();
        mockBridgeBusPublish.mockClear();

        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON", duration: 30});
        await flushPromises();

        expect(controller.state.get(device)).toStrictEqual({brightness: 50, color_temp: 370, linkquality: 99, state: "ON", duration: 30});
    });

    it("Publish entity state keeps an action_duration out of the cache", async () => {
        await controller.start();
        mockBridgeBusPublish.mockClear();

        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON", action_duration: 1500});
        await flushPromises();

        expect(controller.state.get(device)).toStrictEqual({brightness: 50, color_temp: 370, linkquality: 99, state: "ON"});
    });

    it("Publish entity state attribute_json output filtered cache", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute_and_json");
        settings.set(["devices", devices.bulb.ieeeAddr, "filtered_cache"], ["linkquality"]);
        mockBridgeBusPublish.mockClear();

        const device = getZ2MDevice("bulb");
        expect(controller.state.get(device)).toStrictEqual({brightness: 50, color_temp: 370, linkquality: 99, state: "ON"});

        await controller.publishEntityState(device, {state: "ON", brightness: 200, color_temp: 370, linkquality: 87});
        await flushPromises();

        expect(controller.state.get(device)).toStrictEqual({brightness: 200, color_temp: 370, state: "ON"});
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(5);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/brightness", "200", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/linkquality", "87", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 200, color_temp: 370, linkquality: 87}),
            {retain: true},
        );
    });

    it("Publish entity state attribute_json output filtered cache (device_options)", async () => {
        await controller.start();
        settings.set(["advanced", "output"], "attribute_and_json");
        settings.set(["device_options", "filtered_cache"], ["linkquality"]);
        mockBridgeBusPublish.mockClear();

        const device = getZ2MDevice("bulb");
        expect(controller.state.get(device)).toStrictEqual({brightness: 50, color_temp: 370, linkquality: 99, state: "ON"});

        await controller.publishEntityState(device, {state: "ON", brightness: 200, color_temp: 370, linkquality: 87});
        await flushPromises();

        expect(controller.state.get(device)).toStrictEqual({brightness: 200, color_temp: 370, state: "ON"});
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(5);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/state", "ON", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/brightness", "200", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb/linkquality", "87", {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 200, color_temp: 370, linkquality: 87}),
            {retain: true},
        );
    });

    it("Publish entity state with device information", async () => {
        await controller.start();
        settings.set(["advanced", "include_device_information"], true);
        mockBridgeBusPublish.mockClear();
        let device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON"});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({
                state: "ON",
                brightness: 50,
                color_temp: 370,
                linkquality: 99,
                device: {
                    friendlyName: "bulb",
                    model: "LED1545G12",
                    ieeeAddr: "0x000b57fffec6a5b2",
                    networkAddress: 40369,
                    type: "Router",
                    manufacturerID: 4476,
                    powerSource: "Mains (single phase)",
                },
            }),
            {retain: true},
        );

        // Unsupported device should have model "unknown"
        device = getZ2MDevice("unsupported2");
        await controller.publishEntityState(device, {state: "ON"});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/unsupported2",
            stringify({
                state: "ON",
                device: {
                    friendlyName: "unsupported2",
                    model: "notSupportedModelID",
                    ieeeAddr: "0x0017880104e45529",
                    networkAddress: 6536,
                    type: "EndDevice",
                    manufacturerID: 0,
                    powerSource: "Battery",
                },
            }),
            {retain: false},
        );
    });

    it("Should publish entity state without retain", async () => {
        await controller.start();
        settings.set(["devices", devices.bulb.ieeeAddr, "retain"], false);
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON"});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 50, color_temp: 370, linkquality: 99}),
            {retain: false},
        );
    });

    it("Should publish entity state with retain", async () => {
        await controller.start();
        settings.set(["devices", devices.bulb.ieeeAddr, "retain"], true);
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON"});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledWith(
            "zigbee2matter/bulb",
            stringify({state: "ON", brightness: 50, color_temp: 370, linkquality: 99}),
            {retain: true},
        );
    });

    it("Publish entity state no empty messages", async () => {
        data.writeEmptyState();
        await controller.start();
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(0);
    });

    it("Should allow to disable state persistency", async () => {
        settings.set(["advanced", "cache_state_persistent"], false);
        data.removeState();
        await controller.start();
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON"});
        await controller.publishEntityState(device, {brightness: 200});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({state: "ON"}), {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({state: "ON", brightness: 200}), {retain: true});
        await controller.stop();
        expect(data.stateExists()).toBeFalsy();
    });

    it("Shouldnt crash when it cannot save state", async () => {
        data.removeState();
        await controller.start();
        mockLogger.error.mockClear();
        // @ts-expect-error private
        controller.state.file = "/";
        // @ts-expect-error private
        controller.state.save();
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringMatching(/Failed to write state to '\/'/));
    });

    it("Publish should not cache when set", async () => {
        settings.set(["advanced", "cache_state"], false);
        data.writeEmptyState();
        await controller.start();
        mockBridgeBusPublish.mockClear();
        const device = getZ2MDevice("bulb");
        await controller.publishEntityState(device, {state: "ON"});
        await controller.publishEntityState(device, {brightness: 200});
        await flushPromises();
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(2);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({state: "ON"}), {retain: true});
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/bulb", stringify({brightness: 200}), {retain: true});
    });

    it("Should start when state is corrupted", async () => {
        fs.writeFileSync(path.join(data.mockDir, "state.json"), "corrupted");
        await controller.start();
        await flushPromises();
        // @ts-expect-error private
        expect(controller.state.state).toStrictEqual(new Map());
    });

    it("Should publish last seen changes", async () => {
        settings.set(["advanced", "last_seen"], "epoch");
        await controller.start();
        await flushPromises();
        mockBridgeBusPublish.mockClear();
        const device = devices.remote;
        await mockZHEvents.lastSeenChanged({device, reason: "deviceAnnounce"});
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(1);
        expect(mockBridgeBusPublish).toHaveBeenCalledWith("zigbee2matter/remote", stringify({brightness: 255, last_seen: 1000}), {retain: true});
    });

    it("Should not publish last seen changes when reason is messageEmitted", async () => {
        settings.set(["advanced", "last_seen"], "epoch");
        await controller.start();
        await flushPromises();
        mockBridgeBusPublish.mockClear();
        const device = devices.remote;
        await mockZHEvents.lastSeenChanged({device, reason: "messageEmitted"});
        expect(mockBridgeBusPublish).toHaveBeenCalledTimes(0);
    });

    it("Ignore messages from coordinator", async () => {
        // https://github.com/Koenkk/zigbee2mqtt/issues/9218
        await controller.start();
        const device = devices.coordinator;
        const payload = {
            device,
            endpoint: device.getEndpoint(1),
            type: "attributeReport",
            linkquality: 10,
            cluster: "genBasic",
            data: {modelId: device.modelID},
        };
        await mockZHEvents.message(payload);
        await flushPromises();
        expect(mockLogger.log).toHaveBeenCalledWith(
            "debug",
            `Received Zigbee message from 'Coordinator', type 'attributeReport', cluster 'genBasic', data '{}' from endpoint 1, ignoring since it is from coordinator`,
            "z2m",
        );
    });

    it("Should remove state of removed device when stopped", async () => {
        await controller.start();
        const device = getZ2MDevice("bulb");
        expect(controller.state.get(device)).toStrictEqual({brightness: 50, color_temp: 370, linkquality: 99, state: "ON"});
        device.zh.isDeleted = true;
        await controller.stop();
        // @ts-expect-error private
        expect(controller.state.state.get(device.ieeeAddr)).toStrictEqual(undefined);
    });

    it("EventBus should handle sync errors", async () => {
        const eventbus = controller.eventBus;
        const callback = vi.fn().mockImplementation(() => {
            throw new Error("Whoops!");
        });
        eventbus.onStateChange({constructor: {name: "Test"}}, callback);
        eventbus.emitStateChange({});
        await flushPromises();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(`EventBus error 'Test/stateChange': Whoops!`);
    });

    it("EventBus should handle async errors", async () => {
        const eventbus = controller.eventBus;
        const callback = vi.fn().mockRejectedValue(new Error("Whoops!"));
        eventbus.onStateChange({constructor: {name: "Test"}}, callback);
        eventbus.emitStateChange({});
        await flushPromises();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(`EventBus error 'Test/stateChange': Whoops!`);
    });

    it("prevents interacting with invalid extensions", async () => {
        await controller.start();

        await expect(async () => {
            await controller.enableDisableExtension(true, "Fake");
        }).rejects.toThrow("Extension Fake does not exist (should be added with 'addExtension') or is built-in that cannot be enabled at runtime");

        await expect(async () => {
            await controller.enableDisableExtension(false, "Availability");
        }).rejects.toThrow("Built-in extension Availability cannot be disabled at runtime");
    });

    it("throws error when adding extension twice", async () => {
        settings.set(["frontend", "enabled"], true);
        await controller.start();
        await expect(async () => {
            await controller.addExtension(new Frontend(...controller.extensionArgs));
        }).rejects.toThrow("Extension with name Frontend already present");
    });
});
