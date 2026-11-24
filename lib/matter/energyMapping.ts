/** 순간 전력/누적 에너지 경계 (T046). Matter SDK 호출은 하지 않는다. */

export type PowerUnit = "W" | "kW";
export type EnergyUnit = "Wh" | "kWh";

export interface EnergyObservation {
    instantaneousWatts?: number;
    cumulativeWattHours?: number;
}

export interface CumulativeResult {
    value: number;
    reset: boolean;
}

export class EnergyAccumulator {
    private cumulativeWattHours?: number;

    observe(observation: EnergyObservation): CumulativeResult | undefined {
        if (observation.instantaneousWatts !== undefined) assertFinite(observation.instantaneousWatts, "instantaneous power");
        if (observation.cumulativeWattHours === undefined) return undefined;

        assertNonNegativeFinite(observation.cumulativeWattHours, "cumulative energy");
        const previous = this.cumulativeWattHours;
        this.cumulativeWattHours = observation.cumulativeWattHours;

        return {value: observation.cumulativeWattHours, reset: previous !== undefined && observation.cumulativeWattHours < previous};
    }

    get lastCumulativeWattHours(): number | undefined {
        return this.cumulativeWattHours;
    }
}

/** 명시된 전력 단위만 W로 변환한다. 단위를 추정하지 않는다. */
export function toWatts(value: number, unit: PowerUnit): number {
    assertFinite(value, "power");

    return unit === "W" ? value : value * 1000;
}

/** 명시된 에너지 단위만 Wh로 변환한다. 단위를 추정하지 않는다. */
export function toWattHours(value: number, unit: EnergyUnit): number {
    assertFinite(value, "energy");

    return unit === "Wh" ? value : value * 1000;
}

export function assertMatterIntegerRange(value: number, min: number, max: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be a safe integer in ${min}..${max}`);
    }

    return value;
}

function assertFinite(value: number, name: string): void {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function assertNonNegativeFinite(value: number, name: string): void {
    assertFinite(value, name);
    if (value < 0) throw new Error(`${name} must be non-negative`);
}
