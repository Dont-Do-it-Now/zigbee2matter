/** MQTT 재유입 정적 게이트(T072). */

export interface MqttGateInput {
    readonly dependencies: readonly string[];
    readonly imports: readonly string[];
    readonly configKeys: readonly string[];
    readonly allowedExceptions?: readonly string[];
}

export interface MqttGateResult {
    readonly passed: boolean;
    readonly violations: readonly string[];
}

export function evaluateMqttFreeGate(input: MqttGateInput): MqttGateResult {
    const allowed = new Set(input.allowedExceptions ?? []);
    const violations = [
        ...input.dependencies.filter((value) => value === "mqtt" || value.startsWith("mqtt/")),
        ...input.imports.filter((value) => /(^|[/\\])mqtt([./]|$)/i.test(value)),
        ...input.configKeys.filter((value) => /(^|[._-])mqtt([._-]|$)/i.test(value)),
    ].filter((value, index, all) => all.indexOf(value) === index && !allowed.has(value));
    return {passed: violations.length === 0, violations};
}
