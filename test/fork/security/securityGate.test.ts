import {describe, expect, it} from "vitest";

import {evaluateSecurityGateFixtures, securityGateFixtures} from "./securityGate.fixture";

describe("security gate fixtures (T073)", () => {
    it("covers PASS, NOT RUN and FAIL outcomes", () => {
        expect(new Set(securityGateFixtures.map((fixture) => fixture.expected))).toEqual(new Set(["PASS", "NOT RUN", "FAIL"]));
    });

    it.each(evaluateSecurityGateFixtures().map((evaluation) => [evaluation.name, evaluation] as const))("%s", (_name, evaluation) => {
        expect(evaluation.actual).toBe(evaluation.expected);
        expect(evaluation.passed).toBe(true);
    });

    it("never reports PASS when any fixture lacks evidence or implementation", () => {
        for (const evaluation of evaluateSecurityGateFixtures()) {
            if (evaluation.expected !== "PASS") expect(evaluation.actual).not.toBe("PASS");
        }
    });
});
