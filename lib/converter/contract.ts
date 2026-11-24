/**
 * zigbee-herdsman-converters definition의 경계 계약(T030).
 * 실제 converter 실행은 기존 publish/receive/configure/onEvent 경로에 위임한다.
 */

export interface ConverterContractIssue {
    code:
        | "DEFINITION_INVALID"
        | "FROM_ZIGBEE_INVALID"
        | "TO_ZIGBEE_INVALID"
        | "EXPOSES_INVALID"
        | "OPTIONS_INVALID"
        | "CONVERTER_METHOD_MISSING";
    detail: string;
}

export interface ConverterContractReport {
    supported: boolean;
    issues: readonly ConverterContractIssue[];
    capabilities: {
        fromZigbee: boolean;
        toZigbee: boolean;
        configure: boolean;
        onEvent: boolean;
        dynamicExposes: boolean;
        manufacturerOptions: boolean;
    };
}

/** 외부 definition을 등록하기 전에 원본 converter 계약을 확인한다. */
export function inspectConverterDefinition(definition: unknown): ConverterContractReport {
    const issues: ConverterContractIssue[] = [];

    if (!isRecord(definition)) {
        return {
            supported: false,
            issues: [{code: "DEFINITION_INVALID", detail: "converter definition은 객체여야 합니다."}],
            capabilities: emptyCapabilities(),
        };
    }

    const fromZigbee = definition.fromZigbee;
    const toZigbee = definition.toZigbee;
    const exposes = definition.exposes;
    const options = definition.options;

    // upstream ExternalDefinitionWithExtend: extend만 쓰는 정의는 fromZigbee/toZigbee가 없을 수 있다.
    if (fromZigbee === undefined) {
        // extend 등으로 대체되므로 허용
    } else if (!Array.isArray(fromZigbee)) {
        issues.push({code: "FROM_ZIGBEE_INVALID", detail: "fromZigbee는 배열이어야 합니다."});
    } else {
        validateFromZigbee(fromZigbee, issues);
    }

    if (toZigbee === undefined) {
        // extend 등으로 대체되므로 허용
    } else if (!Array.isArray(toZigbee)) {
        issues.push({code: "TO_ZIGBEE_INVALID", detail: "toZigbee는 배열이어야 합니다."});
    } else {
        validateToZigbee(toZigbee, issues);
    }

    if (exposes !== undefined && !Array.isArray(exposes) && typeof exposes !== "function") {
        issues.push({code: "EXPOSES_INVALID", detail: "exposes는 배열 또는 동적 exposes 함수여야 합니다."});
    }

    if (options !== undefined && !Array.isArray(options)) {
        issues.push({code: "OPTIONS_INVALID", detail: "manufacturer options는 배열로 원본 보존되어야 합니다."});
    }

    return {
        supported: issues.length === 0,
        issues,
        capabilities: {
            fromZigbee: Array.isArray(fromZigbee),
            toZigbee: Array.isArray(toZigbee),
            configure: typeof definition.configure === "function",
            onEvent: typeof definition.onEvent === "function",
            dynamicExposes: typeof exposes === "function",
            manufacturerOptions: Array.isArray(options),
        },
    };
}

/**
 * 동적 exposes는 장치와 options를 그대로 converter에 전달한다.
 * 호출 실패를 숨기지 않고 명시적 오류로 돌려 fallback을 막는다.
 */
export function resolveDynamicExposes(definition: unknown, device: unknown, options: unknown): unknown[] {
    if (!isRecord(definition)) throw new Error("converter definition은 객체여야 합니다.");

    const exposes = definition.exposes;
    if (typeof exposes === "function") {
        const resolved = exposes(device, options);
        if (!Array.isArray(resolved)) throw new Error("dynamic exposes가 배열을 반환하지 않았습니다.");
        return resolved;
    }

    if (Array.isArray(exposes)) return exposes;
    return [];
}

function validateFromZigbee(converters: readonly unknown[], issues: ConverterContractIssue[]): void {
    for (const converter of converters) {
        if (!isRecord(converter) || typeof converter.convert !== "function") {
            issues.push({code: "CONVERTER_METHOD_MISSING", detail: "fromZigbee converter에는 convert 함수가 필요합니다."});
        }
    }
}

function validateToZigbee(converters: readonly unknown[], issues: ConverterContractIssue[]): void {
    for (const converter of converters) {
        if (!isRecord(converter) || (typeof converter.convertSet !== "function" && typeof converter.convertGet !== "function")) {
            issues.push({code: "CONVERTER_METHOD_MISSING", detail: "toZigbee converter에는 convertSet 또는 convertGet 함수가 필요합니다."});
        }
    }
}

function emptyCapabilities(): ConverterContractReport["capabilities"] {
    return {
        fromZigbee: false,
        toZigbee: false,
        configure: false,
        onEvent: false,
        dynamicExposes: false,
        manufacturerOptions: false,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
