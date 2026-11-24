// biome-ignore assist/source/organizeImports: import mocks first
import {mockLogger} from "./mocks/logger";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {BASE_TOPIC, InProcessBridgeBus} from "../lib/bridgeBus";
import EventBus from "../lib/eventBus";

describe("InProcessBridgeBus", () => {
    let eventBus: EventBus;
    let bridgeBus: InProcessBridgeBus;
    let published: eventdata.BridgeBusMessagePublished[];
    let received: eventdata.BridgeBusMessage[];

    beforeEach(() => {
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        eventBus = new EventBus();
        bridgeBus = new InProcessBridgeBus(eventBus, BASE_TOPIC);
        published = [];
        received = [];
        eventBus.onBridgeBusMessagePublished({constructor: {name: "PublishedListener"}}, (data) => {
            published.push(data);
        });
        eventBus.onBridgeBusMessage({constructor: {name: "ReceivedListener"}}, (data) => {
            received.push(data);
        });
    });

    it("uses the internal base topic constant", () => {
        expect(BASE_TOPIC).toStrictEqual("zigbee2matter");
    });

    it("reports in-process info and stats without a broker", async () => {
        expect(bridgeBus.info).toStrictEqual({version: undefined, server: "in-process"});
        expect(bridgeBus.isConnected()).toStrictEqual(false);
        expect(bridgeBus.stats).toStrictEqual({connected: false, queued: 0});
        await bridgeBus.connect();
        expect(bridgeBus.isConnected()).toStrictEqual(true);
        expect(bridgeBus.stats).toStrictEqual({connected: true, queued: 0});
    });

    it("publishes retained online state on connect", async () => {
        await bridgeBus.connect();
        expect(published).toHaveLength(1);
        expect(published[0].topic).toStrictEqual("zigbee2matter/bridge/state");
        expect(published[0].payload).toStrictEqual(JSON.stringify({state: "online"}));
        expect(published[0].options.clientOptions.retain).toStrictEqual(true);
        expect(bridgeBus.retainedMessages["zigbee2matter/bridge/state"]).toMatchObject({
            topic: "bridge/state",
            payload: JSON.stringify({state: "online"}),
        });
    });

    it("publishes retained offline state on disconnect and removes its listeners", async () => {
        await bridgeBus.connect();
        published.length = 0;
        await bridgeBus.disconnect();
        expect(bridgeBus.isConnected()).toStrictEqual(false);
        expect(published).toHaveLength(1);
        expect(published[0].topic).toStrictEqual("zigbee2matter/bridge/state");
        expect(published[0].payload).toStrictEqual(JSON.stringify({state: "offline"}));
        expect(bridgeBus.retainedMessages["zigbee2matter/bridge/state"].payload).toStrictEqual(JSON.stringify({state: "offline"}));
    });

    it("does not publish offline state on disconnect when never connected", async () => {
        await bridgeBus.disconnect();
        expect(published).toHaveLength(0);
    });

    it("prefixes the base topic, applies default options and counts published messages", async () => {
        await bridgeBus.publish("bulb", '{"state":"ON"}');
        expect(published).toHaveLength(1);
        expect(published[0]).toStrictEqual({
            topic: "zigbee2matter/bulb",
            payload: '{"state":"ON"}',
            options: {clientOptions: {}, baseTopic: "zigbee2matter", skipLog: false, meta: {}},
        });
        expect(eventBus.stats.bridgeBus.published).toStrictEqual(1);
        expect(bridgeBus.retainedMessages).toStrictEqual({});
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
    });

    it("respects skipLog and a custom base topic option", async () => {
        await bridgeBus.publish("bridge/logging", "x", {skipLog: true, baseTopic: "custom"});
        expect(published[0].topic).toStrictEqual("custom/bridge/logging");
        expect(mockLogger.info).toHaveBeenCalledTimes(0);
    });

    it("keeps retained messages in the snapshot, overwrites them and clears them on empty payload", async () => {
        await bridgeBus.publish("bridge/info", "one", {clientOptions: {retain: true}});
        await bridgeBus.publish("bridge/info", "two", {clientOptions: {retain: true}});
        expect(Object.keys(bridgeBus.retainedMessages)).toStrictEqual(["zigbee2matter/bridge/info"]);
        expect(bridgeBus.retainedMessages["zigbee2matter/bridge/info"].payload).toStrictEqual("two");
        expect(bridgeBus.retainedMessages["zigbee2matter/bridge/info"].topic).toStrictEqual("bridge/info");

        await bridgeBus.publish("bridge/info", "", {clientOptions: {retain: true}});
        expect(bridgeBus.retainedMessages).toStrictEqual({});
    });

    it("does not retain non-retained messages", async () => {
        await bridgeBus.publish("bulb", "x", {clientOptions: {retain: false}});
        expect(bridgeBus.retainedMessages).toStrictEqual({});
    });

    it.each(["z2m/#/status", "z2m/+/status"])("refuses to publish wildcard topic '%s'", async (topic) => {
        await bridgeBus.publish(topic, "empty");
        expect(published).toHaveLength(0);
        expect(eventBus.stats.bridgeBus.published).toStrictEqual(0);
        expect(mockLogger.error).toHaveBeenCalledWith(`Topic '${topic}' includes wildcard characters, skipping publish.`);
    });

    it("dispatches inbound messages as strings and counts received messages", () => {
        bridgeBus.onMessage("zigbee2matter/bulb/set", Buffer.from('{"state":"OFF"}', "utf8"));
        bridgeBus.onMessage("zigbee2matter/bulb/get", "plain");
        expect(received).toStrictEqual([
            {topic: "zigbee2matter/bulb/set", message: '{"state":"OFF"}'},
            {topic: "zigbee2matter/bulb/get", message: "plain"},
        ]);
        expect(eventBus.stats.bridgeBus.received).toStrictEqual(2);
        expect(mockLogger.debug).toHaveBeenCalled();
    });

    it("keeps onMessage bound to the instance", () => {
        const {onMessage} = bridgeBus;
        onMessage("zigbee2matter/x", "y");
        expect(received).toStrictEqual([{topic: "zigbee2matter/x", message: "y"}]);
    });

    it("has no broker client surface", () => {
        expect(bridgeBus).not.toHaveProperty("client");
        expect(bridgeBus).not.toHaveProperty("subscribe");
        expect(bridgeBus).not.toHaveProperty("unsubscribe");
        expect(vi.isMockFunction(bridgeBus.publish)).toStrictEqual(false);
    });
});
