/** 잠금/온도조절의 보안·범위 경계 (T047). */
import {celsiusToMatter, type KnownValue} from "./sensorMapping";

export type LockCommand = "lock" | "unlock";
export type LockCommandStatus = "confirmed" | "unknown" | "denied" | "timeout";

export interface LockOutcome {
    status: LockCommandStatus;
    locked?: boolean;
}

export function authorizeLockCommand(command: LockCommand, allowed: boolean): LockCommand {
    if (!allowed) throw new Error(`lock command '${command}' is not authorized`);

    return command;
}

export function resolveLockOutcome(observedLocked: boolean | undefined, denied = false, timeout = false): LockOutcome {
    if (denied) return {status: "denied"};
    if (timeout) return {status: "timeout"};
    if (observedLocked === undefined) return {status: "unknown"};

    return {status: "confirmed", locked: observedLocked};
}

export function validateThermostatMode(mode: string, supportedModes: readonly string[]): string {
    if (!supportedModes.includes(mode)) throw new Error(`unsupported thermostat mode: ${mode}`);

    return mode;
}

export function celsiusSetpointToMatter(value: number, min: number, max: number): KnownValue<number> {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error("invalid thermostat setpoint range");
    if (value < min || value > max) throw new Error(`thermostat setpoint must be in ${min}..${max}°C`);

    return celsiusToMatter(value);
}

export type ZigbeeSystemMode = "off" | "auto" | "cool" | "heat" | "emergency_heating";

export function zigbeeSystemModeToMatter(value: unknown): number | undefined {
    if (value === "off") return 0;
    if (value === "auto") return 1;
    if (value === "cool") return 3;
    if (value === "heat") return 4;
    if (value === "emergency_heating") return 5;

    return undefined;
}

export function matterSystemModeToZigbee(value: number): ZigbeeSystemMode | undefined {
    if (value === 0) return "off";
    if (value === 1) return "auto";
    if (value === 3) return "cool";
    if (value === 4) return "heat";
    if (value === 5) return "emergency_heating";

    return undefined;
}

/** Matter DoorLock LockState: 0 NotFullyLocked, 1 Locked, 2 Unlocked. 알 수 없는 값은 undefined. */
export function zigbeeLockStateToMatter(value: unknown): number | undefined {
    if (value === "locked" || value === "LOCK" || value === "LOCKED") return 1;
    if (value === "unlocked" || value === "UNLOCK" || value === "UNLOCKED") return 2;
    if (value === "not_fully_locked") return 0;

    return undefined;
}

/** Matter 0.01°C 설정값을 °C로 환산한다. 범위가 주어지면 벗어난 값을 거부한다. */
export function matterSetpointToCelsius(value: number, range?: {min: number; max: number}): number {
    if (!Number.isFinite(value)) throw new Error("thermostat setpoint must be finite");
    const celsius = value / 100;
    if (range !== undefined && (celsius < range.min || celsius > range.max)) {
        throw new Error(`thermostat setpoint must be in ${range.min}..${range.max}°C`);
    }

    return celsius;
}
