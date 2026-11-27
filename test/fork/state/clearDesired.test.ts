// z2m-fork: a failed/timed-out command's intent is dropped so Matter falls back to the last observed state.
import {describe, expect, it} from "vitest";
import StateReconciler from "../../../lib/state/reconciliation";

describe("StateReconciler.clearDesired", () => {
    it("removes an unreached intent and keeps the observed value", () => {
        const state = new StateReconciler();
        state.observe("k", {state: "OFF"});
        state.desire("k", {state: "ON"});
        expect(state.get("k")?.desiredValue).toEqual({state: "ON"});

        const record = state.clearDesired("k");

        expect(record?.desiredValue).toBeUndefined();
        expect(record?.observedValue).toEqual({state: "OFF"});
        expect(record?.quality).toBe("confirmed");
    });

    it("is a no-op without an intent", () => {
        const state = new StateReconciler();
        state.observe("k", {state: "OFF"});
        const revision = state.lastRevision;

        expect(state.clearDesired("k")).toBeUndefined();
        expect(state.clearDesired("missing")).toBeUndefined();
        expect(state.lastRevision).toBe(revision);
    });

    it("a later unchanged report still publishes the observed value without the intent", () => {
        const state = new StateReconciler();
        state.observe("k", {state: "OFF"});
        state.desire("k", {state: "ON"});

        const record = state.observe("k", {state: "OFF"});

        expect(record.desiredValue).toBeUndefined();
        expect(record.observedValue).toEqual({state: "OFF"});
    });
});
