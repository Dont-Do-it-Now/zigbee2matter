// z2m-fork: a set whose requested state the device already reported must not hold the queue until its ZCL Default Response times out.
import {describe, expect, it, vi} from "vitest";
import EventBus from "../../../lib/eventBus";
import Publish from "../../../lib/extension/publish";

vi.mock("../../../lib/util/logger", () => ({default: {info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn()}}));

describe("Publish queue release", () => {
    it("starts the next queued set once the in-flight set's state is reported, before the in-flight call settles", async () => {
        const eventBus = new EventBus();
        // The topic token is the friendly name; state changes carry the entity's IEEE address.
        const zigbee = {
            resolveEntityAndEndpoint: () => ({ID: "주방등", endpointID: "center"}),
            resolveEntity: () => ({ID: "0x00124b0001020304"}),
        };
        const publish = new Publish(
            zigbee as never,
            {} as never,
            {} as never,
            (async () => {}) as never,
            eventBus,
            async () => {},
            async () => {},
            async () => {},
        );
        await publish.start();

        const started: string[] = [];
        const gates: (() => void)[] = [];
        vi.spyOn(
            publish as unknown as {processBridgeBusMessage: (data: {message: string}) => Promise<void>},
            "processBridgeBusMessage",
        ).mockImplementation((data) => {
            started.push(data.message);

            return new Promise<void>((resolve) => gates.push(resolve));
        });

        const topic = "zigbee2matter/주방등/center/set";
        const first = publish.onBridgeBusMessage({topic, message: JSON.stringify({state: "ON"})});
        await vi.waitFor(() => expect(started).toHaveLength(1));
        const second = publish.onBridgeBusMessage({topic, message: JSON.stringify({state: "OFF"})});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(started).toHaveLength(1); // OFF is queued behind the in-flight ON

        // Optimistic values are not device reports and must not release the queue.
        eventBus.emitStateChange({
            entity: {ID: "0x00124b0001020304"},
            from: {},
            to: {state_center: "ON"},
            update: {state_center: "ON"},
            reason: "commandOptimistic",
        } as never);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(started).toHaveLength(1);

        // The device reports ON; the ZCL call is still waiting for its Default Response.
        eventBus.emitStateChange({entity: {ID: "0x00124b0001020304"}, from: {}, to: {state_center: "ON"}, update: {state_center: "ON"}} as never);
        await first;
        await vi.waitFor(() => expect(started).toHaveLength(2));
        expect(gates).toHaveLength(2);

        gates[0](); // the late ZCL result of ON must not matter
        gates[1]();
        await second;
    });
});
