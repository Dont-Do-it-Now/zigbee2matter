/** 온습도·접촉 센서의 단위/상태 경계 (T043). SDK 호출은 하지 않는다. */

export type KnownValue<T> = {known: true; value: T} | {known: false};

export type BooleanSensorSemantic = "contact" | "occupancy";

export interface MatterBooleanSensorValue {
    semantic: BooleanSensorSemantic;
    cluster: "BooleanState" | "OccupancySensing";
    value: boolean;
}

/** Matter TemperatureMeasurement의 0.01°C 표현. */
export function celsiusToMatter(value: number | null | undefined): KnownValue<number> {
    if (value === null || value === undefined) return {known: false};
    assertFinite(value, "temperature");

    const scaled = Math.round(value * 100);
    if (scaled < -32768 || scaled > 32767) throw new Error("temperature is outside Matter int16 range");

    return {known: true, value: scaled};
}

/** Matter RelativeHumidityMeasurement의 0.01% 표현. */
export function humidityPercentToMatter(value: number | null | undefined): KnownValue<number> {
    if (value === null || value === undefined) return {known: false};
    assertFinite(value, "humidity");
    if (value < 0 || value > 100) throw new Error("humidity must be in 0..100 percent");

    return {known: true, value: Math.round(value * 100)};
}

export function booleanSensorToMatter(value: boolean | null | undefined, invert = false): KnownValue<boolean> {
    if (value === null || value === undefined) return {known: false};

    return {known: true, value: invert ? !value : value};
}

/** Contact와 Occupancy를 서로 다른 Matter cluster 의미로 명시적으로 구분한다. */
export function booleanSensorBySemantic(
    semantic: BooleanSensorSemantic,
    value: boolean | null | undefined,
    invert = false,
): KnownValue<MatterBooleanSensorValue> {
    if (value === null || value === undefined) return {known: false};

    return {
        known: true,
        value: {
            semantic,
            cluster: semantic === "contact" ? "BooleanState" : "OccupancySensing",
            value: invert ? !value : value,
        },
    };
}

/** 센서 expose에 쓰기 명령을 보내지 않도록 호출부에서 명시적으로 검사한다. */
export function assertSensorReadOnly(writable: boolean): void {
    if (writable) throw new Error("sensor mapping does not accept write commands");
}

function assertFinite(value: number, name: string): void {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}
