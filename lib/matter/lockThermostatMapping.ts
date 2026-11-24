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

/** 잠금은 비멱등 명령으로 취급해 자동 재시도를 허용하지 않는다. */
export function lockAutoRetryAllowed(): false {
    return false;
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
