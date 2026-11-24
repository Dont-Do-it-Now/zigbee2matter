/**
 * 조명/스위치 값 변환의 순수 경계 (T042).
 *
 * Matter SDK나 Zigbee endpoint를 직접 호출하지 않는다. OnOff가 brightness 0을
 * 표현하므로 Level 값 자체는 1..254로 보존하며, transition은 단위를 추정하지 않는다.
 */

export const ZIGBEE_BRIGHTNESS_MIN = 0;
export const ZIGBEE_BRIGHTNESS_MAX = 254;
export const MATTER_LEVEL_MIN = 1;
export const MATTER_LEVEL_MAX = 254;

export interface MatterLevelValue {
    level: number;
    on: boolean;
}

export interface MatterColorValue {
    hue: number;
    saturation: number;
}

export interface ZigbeeColorValue {
    hue: number;
    saturation: number;
}

export interface MatterColorXyValue {
    x: number;
    y: number;
}

export interface ZigbeeColorXyValue {
    x: number;
    y: number;
}

export function zigbeeBrightnessToMatter(value: number): MatterLevelValue {
    assertIntegerRange(value, ZIGBEE_BRIGHTNESS_MIN, ZIGBEE_BRIGHTNESS_MAX, "brightness");

    if (value === 0) return {level: MATTER_LEVEL_MIN, on: false};

    return {level: scale(value - 1, ZIGBEE_BRIGHTNESS_MAX - 1, MATTER_LEVEL_MIN, MATTER_LEVEL_MAX), on: true};
}

export function matterLevelToZigbee(level: number, on = true): number {
    assertIntegerRange(level, MATTER_LEVEL_MIN, MATTER_LEVEL_MAX, "level");

    if (!on) return ZIGBEE_BRIGHTNESS_MIN;

    return scale(level - MATTER_LEVEL_MIN, MATTER_LEVEL_MAX - MATTER_LEVEL_MIN, 1, ZIGBEE_BRIGHTNESS_MAX);
}

/** Zigbee hue 0..360 / saturation 0..100을 Matter ColorControl 0..254로 변환한다. */
export function zigbeeColorToMatter(hue: number, saturation: number): MatterColorValue {
    assertIntegerRange(hue, 0, 360, "hue");
    assertFiniteRange(saturation, 0, 100, "saturation");

    return {
        hue: Math.round((hue / 360) * 254),
        saturation: Math.round((saturation / 100) * 254),
    };
}

export function matterColorToZigbee(hue: number, saturation: number): ZigbeeColorValue {
    assertIntegerRange(hue, 0, 254, "Matter hue");
    assertIntegerRange(saturation, 0, 254, "Matter saturation");

    return {
        hue: (hue / 254) * 360,
        saturation: (saturation / 254) * 100,
    };
}

/** Zigbee xy 0..1을 Matter ColorControl uint16 범위로 변환한다. */
export function zigbeeColorXyToMatter(x: number, y: number): MatterColorXyValue {
    assertFiniteRange(x, 0, 1, "color x");
    assertFiniteRange(y, 0, 1, "color y");

    return {x: Math.round(x * 0xffff), y: Math.round(y * 0xffff)};
}

export function matterColorXyToZigbee(x: number, y: number): ZigbeeColorXyValue {
    assertIntegerRange(x, 0, 0xffff, "Matter color x");
    assertIntegerRange(y, 0, 0xffff, "Matter color y");

    return {x: x / 0xffff, y: y / 0xffff};
}

/** 색온도는 양쪽 계약의 mired 값을 그대로 전달하고, 범위만 검증한다. */
export function validateColorTemperatureMireds(value: number, min = 1, max = 1000): number {
    assertIntegerRange(value, min, max, "color temperature mireds");

    return value;
}

/** transition 단위 변환은 SDK adapter 소유로 남기고 음이 아닌 정수만 허용한다. */
export function validateTransitionMilliseconds(value: number): number {
    assertIntegerRange(value, 0, Number.MAX_SAFE_INTEGER, "transition milliseconds");

    return value;
}

function scale(value: number, sourceMax: number, targetMin: number, targetMax: number): number {
    return Math.min(targetMax, Math.max(targetMin, Math.round((value / sourceMax) * (targetMax - targetMin) + targetMin)));
}

function assertIntegerRange(value: number, min: number, max: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer in ${min}..${max}`);
    }
}

function assertFiniteRange(value: number, min: number, max: number, name: string): void {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be finite and in ${min}..${max}`);
    }
}
