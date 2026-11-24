export interface OtaAdmissionInput {
    powerSource?: string;
    batteryPercent?: number;
    activeJobs: number;
    maxConcurrent: number;
    minBatteryPercent: number;
}

export interface OtaAdmission {
    allowed: boolean;
    reason?: "concurrency-limit" | "battery-level-unavailable" | "battery-too-low" | "invalid-battery-level";
}

/** OTA 전송을 시작하기 전에 안전 조건을 판정한다. 장치나 네트워크에는 접근하지 않는다. */
export function evaluateOtaAdmission(input: OtaAdmissionInput): OtaAdmission {
    if (!Number.isInteger(input.activeJobs) || input.activeJobs < 0 || input.activeJobs >= input.maxConcurrent) {
        return {allowed: false, reason: "concurrency-limit"};
    }

    if (input.powerSource !== "Battery") return {allowed: true};
    if (input.batteryPercent === undefined) return {allowed: false, reason: "battery-level-unavailable"};
    if (!Number.isFinite(input.batteryPercent) || input.batteryPercent < 0 || input.batteryPercent > 100) {
        return {allowed: false, reason: "invalid-battery-level"};
    }
    if (input.batteryPercent < input.minBatteryPercent) return {allowed: false, reason: "battery-too-low"};

    return {allowed: true};
}
