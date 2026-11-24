/** T012 exposes 기반 ValueValidator. 알려진 expose 속성의 접근 권한/범위/enum만 검증하고, 모르는 키는 converter에 맡긴다. */
import type {EntityCommand, ResolvedTarget, ValueRejection, ValueValidator} from "../command/types";
import type Zigbee from "../zigbee";

const ACCESS_SET = 0b010;

interface ExposeLike {
    property?: string;
    type?: string;
    access?: number;
    endpoint?: string;
    value_min?: number;
    value_max?: number;
    value_on?: unknown;
    value_off?: unknown;
    value_toggle?: unknown;
    values?: readonly unknown[];
    features?: readonly ExposeLike[];
}

function flatten(exposes: readonly ExposeLike[], into: ExposeLike[] = []): ExposeLike[] {
    for (const expose of exposes) {
        if (expose.property !== undefined) into.push(expose);
        if (expose.features && expose.type !== "composite") flatten(expose.features, into);
    }

    return into;
}

export default class ExposesValueValidator implements ValueValidator {
    constructor(private readonly zigbee: Zigbee) {}

    validate(command: EntityCommand, resolved: Extract<ResolvedTarget, {ok: true}>): ValueRejection | undefined {
        if (command.operation !== "set" || resolved.kind !== "device") return undefined;

        const entity = this.zigbee.resolveEntity(resolved.name);
        if (!entity?.isDevice() || !entity.isSupported) return undefined;

        const exposes = flatten(entity.exposes() as unknown as ExposeLike[]);
        for (const [key, value] of Object.entries(command.value)) {
            const expose = exposes.find(
                (item) =>
                    item.property === key ||
                    (item.endpoint !== undefined && `${item.property}_${item.endpoint}` === key) ||
                    (resolved.endpoint !== undefined && item.endpoint === resolved.endpoint && item.property === key),
            );
            if (expose === undefined) continue;

            if (expose.access !== undefined && (expose.access & ACCESS_SET) === 0) {
                return {errorCode: "FORBIDDEN", message: `property '${key}' is not writable`};
            }

            const rejection = validateValue(key, expose, value);
            if (rejection) return rejection;
        }

        return undefined;
    }
}

function validateValue(key: string, expose: ExposeLike, value: unknown): ValueRejection | undefined {
    const invalid = (message: string): ValueRejection => ({errorCode: "INVALID_ARGUMENT", message});

    if (expose.type === "numeric") {
        // upstream converter가 문자열(presets 이름, "toggle", 상대값 등)을 해석하므로 문자열은 converter에 맡긴다.
        if (typeof value === "string") return undefined;
        if (typeof value !== "number" || !Number.isFinite(value)) return invalid(`property '${key}' must be a finite number`);
        if (expose.value_min !== undefined && value < expose.value_min) return invalid(`property '${key}' is below the minimum`);
        if (expose.value_max !== undefined && value > expose.value_max) return invalid(`property '${key}' is above the maximum`);
    } else if (expose.type === "enum") {
        if (expose.values !== undefined && !expose.values.includes(value)) return invalid(`property '${key}' is not an allowed value`);
    } else if (expose.type === "binary") {
        const allowed = [expose.value_on, expose.value_off, expose.value_toggle].filter((item) => item !== undefined);
        const matches = allowed.some(
            (item) => item === value || (typeof item === "string" && typeof value === "string" && item.toLowerCase() === value.toLowerCase()),
        );
        if (allowed.length > 0 && !matches) return invalid(`property '${key}' is not an allowed value`);
    }

    return undefined;
}
