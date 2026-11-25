import {vi} from "vitest";
import type {BridgeBusPublishOptions} from "../../lib/bridgeBus";

// z2m-fork: T006 replaces test/mocks/mqtt.ts. The real InProcessBridgeBus is used (no broker to mock); this module only
// observes it: every message published through `eventBus.bridgeBusMessagePublished` is recorded in `mockBridgeBusPublish`
// (same call shape as the former `mockMQTTPublishAsync`: full topic with base topic, payload, `{retain}`), and `events.message`
// injects an inbound message into the most recently created bus (same usage as the former `mockMQTTEvents.message`).

type MockBus = {onMessage(topic: string, message: Buffer | string): void};

const hoisted = vi.hoisted(() => ({
    buses: [] as MockBus[],
    publish: vi.fn(async (_topic: string, _payload: string, _opts: {retain: boolean}): Promise<void> => {}),
}));

/** Own class so `eventBus.removeListeners(bus)` (keyed by constructor name) never drops the recorder. */
class MockBridgeBusRecorder {}

vi.mock("../../lib/bridgeBus/inProcess", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../lib/bridgeBus/inProcess")>();

    class TrackedInProcessBridgeBus extends original.default {
        constructor(eventBus: ConstructorParameters<typeof original.default>[0], baseTopic: string) {
            super(eventBus, baseTopic);
            hoisted.buses.push(this);
            eventBus.onBridgeBusMessagePublished(new MockBridgeBusRecorder(), (data) => {
                const retain = data.options.clientOptions.retain;
                void hoisted.publish(data.topic, data.payload, retain ? {retain: true} : {});
            });
        }
    }

    return {...original, default: TrackedInProcessBridgeBus};
});

export const mockBridgeBusPublish = hoisted.publish;

/** Inject an inbound message (as an adapter would) into the latest `InProcessBridgeBus`. `topic` includes the base topic. */
export const events = {
    message: (topic: string, message: Buffer | string): void => {
        const bus = hoisted.buses.at(-1);

        if (!bus) {
            throw new Error("No InProcessBridgeBus created yet");
        }

        bus.onMessage(topic, message);
    },
};

export type {BridgeBusPublishOptions};
