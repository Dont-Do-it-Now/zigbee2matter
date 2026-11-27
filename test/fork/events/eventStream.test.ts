import {describe, expect, it, vi} from "vitest";

vi.mock("../../../lib/util/logger", () => ({default: {error: vi.fn(), debug: vi.fn(), info: vi.fn(), warning: vi.fn()}}));

import EventBus from "../../../lib/eventBus";
import {EventStream} from "../../../lib/events";
import StateReconciler from "../../../lib/state/reconciliation";
import StateSnapshotCoordinator from "../../../lib/state/snapshot";

const device = {isDevice: () => true, ieeeAddr: "0x01", ID: "0x01"} as unknown as Device;

function setup(capacity?: number) {
    const bus = new EventBus();
    const stream = new EventStream(capacity);
    stream.attach(bus);

    return {bus, stream};
}

describe("EventStream", () => {
    it("publishes one state delta to multiple consumers", () => {
        const {stream} = setup();
        const snapshots = new StateSnapshotCoordinator(new StateReconciler({now: () => 1}), stream);
        const a = vi.fn();
        const b = vi.fn();
        stream.subscribe(a);
        stream.subscribe(b);
        snapshots.observe("device/0x01", {state: "ON"}, 1);

        expect(stream.stats.published).toBe(1);
        expect(a).toHaveBeenCalledTimes(1);
        expect(a.mock.calls[0][0]).toMatchObject({
            type: "delta",
            key: "device/0x01",
            sequence: 1,
            payload: {key: "device/0x01", observedValue: {state: "ON"}, quality: "confirmed", revision: 1, observedAt: 1},
        });
        expect(b.mock.calls[0][0]).toBe(a.mock.calls[0][0]);
    });

    it("lets a device report override an unreached desired value", () => {
        const reconciler = new StateReconciler({now: () => 1});
        reconciler.observe("device/0x01", {state: "OFF"}, 1);
        reconciler.desire("device/0x01", {state: "OFF"});
        reconciler.desire("device/0x01", {state: "ON"});
        reconciler.observe("device/0x01", {state: "OFF"}, 2);

        expect(reconciler.get("device/0x01")).toMatchObject({observedValue: {state: "OFF"}, quality: "confirmed"});
        expect(reconciler.get("device/0x01")?.desiredValue).toBeUndefined();
    });

    it("keeps rapid button presses as separate transient events", () => {
        const {bus, stream} = setup();
        const msg = {type: "commandOn", device, endpoint: {ID: 1}, linkquality: 1, groupID: 0, cluster: "genOnOff", data: {}, meta: {}};
        for (let i = 0; i < 20; i++) {
            bus.emitDeviceMessage(msg as never);
        }

        const result = stream.replay(0);
        expect(result.resync === false && result.events.filter((e) => e.type === "transient")).toHaveLength(20);
    });

    it("isolates throwing listener", () => {
        const {stream} = setup();
        const ok = vi.fn();
        stream.subscribe(() => {
            throw new Error("boom");
        });
        stream.subscribe(ok);
        stream.publish("availability", "device/0x01", {state: "online"});

        expect(ok).toHaveBeenCalledTimes(1);
        expect(stream.stats.listenerErrors).toBe(1);
    });

    it("bounds buffer and requests resync on gap or epoch change", () => {
        const {stream} = setup(3);
        for (let i = 0; i < 5; i++) {
            stream.publish("delta", "k", i);
        }

        expect(stream.stats.evicted).toBe(2);
        expect(stream.replay(2)).toMatchObject({resync: false});
        expect(stream.replay(1)).toMatchObject({resync: true, reason: "gap", oldestSequence: 3});
        expect(stream.replay(5)).toMatchObject({resync: false, events: []});
        const old = stream.epoch;
        stream.resetEpoch();
        expect(stream.replay(5, old)).toMatchObject({resync: true, reason: "epoch"});
        expect(stream.lastSequence).toBe(1); // epochReset snapshot
        expect(stream.publish("delta", "k", 0).sequence).toBe(2);
    });

    it("rejects invalid replay cursor", () => {
        const {stream} = setup();
        stream.publish("delta", "k", 1);

        for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
            expect(stream.replay(bad)).toMatchObject({resync: true, reason: "invalid"});
        }
    });

    it("counts async listener rejection", async () => {
        const {stream} = setup();
        stream.subscribe(() => Promise.reject(new Error("async boom")));
        stream.publish("delta", "k", 1);
        await Promise.resolve();
        await Promise.resolve();

        expect(stream.stats.listenerErrors).toBe(1);
    });

    it("delivers reentrant publish in sequence order", () => {
        const {stream} = setup();
        const seen: number[] = [];
        let first = true;
        stream.subscribe((e) => {
            seen.push(e.sequence);

            if (first) {
                first = false;
                stream.publish("delta", "k", "inner");
            }
        });
        stream.publish("delta", "k", "outer");
        stream.publish("delta", "k", "next");

        expect(seen).toEqual([1, 2, 3]);
    });

    it("freezes stored events and detach removes bus listeners", () => {
        const {bus, stream} = setup();
        const e = stream.publish("delta", "k", {a: 1});
        expect(Object.isFrozen(e) && Object.isFrozen(e.payload)).toBe(true);
        stream.detach(bus);
        bus.emitDevicesChanged();

        expect(stream.stats.published).toBe(1);
    });
});
