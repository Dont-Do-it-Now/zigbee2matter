/** 순간 전력/누적 에너지 경계 (T046). Matter SDK 호출은 하지 않는다. */

export type PowerUnit = "mW" | "W" | "kW";
export type EnergyUnit = "mWh" | "Wh" | "kWh";
export type ElectricalQuantity = "power" | "energy" | "voltage" | "current";

/** Matter 단위(mW, mWh, mV, mA) 대비 expose unit 배율. 표에 없는 단위는 추정하지 않는다. */
const MATTER_FACTORS: Readonly<Record<ElectricalQuantity, Readonly<Record<string, number>>>> = {
    power: {mW: 1, W: 1000, kW: 1_000_000},
    energy: {mWh: 1, Wh: 1000, kWh: 1_000_000},
    voltage: {mV: 1, V: 1000, kV: 1_000_000},
    current: {mA: 1, A: 1000},
};

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
    const result = value * (MATTER_FACTORS.power[unit] / 1000);
    assertFinite(result, "power");

    return result;
}

/** 명시된 에너지 단위만 Wh로 변환한다. 단위를 추정하지 않는다. */
export function toWattHours(value: number, unit: EnergyUnit): number {
    assertFinite(value, "energy");
    const result = value * (MATTER_FACTORS.energy[unit] / 1000);
    assertFinite(result, "energy");

    return result;
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

export function isKnownElectricalUnit(quantity: ElectricalQuantity, unit: string | undefined): boolean {
    return unit !== undefined && Object.hasOwn(MATTER_FACTORS[quantity], unit);
}

/** expose unit을 읽어 Matter 정수 단위(mW, mWh, mV, mA)로 환산한다. 알 수 없는 단위는 throw한다. */
export function toMatterElectrical(quantity: ElectricalQuantity, value: number, unit: string | undefined): number {
    if (!isKnownElectricalUnit(quantity, unit)) throw new Error(`unsupported ${quantity} unit: ${String(unit)}`);
    assertFinite(value, quantity);
    const result = Math.round(value * (MATTER_FACTORS[quantity][unit as string] as number));
    if (!Number.isSafeInteger(result)) throw new Error(`${quantity} is outside the safe integer range`);

    return result;
}
