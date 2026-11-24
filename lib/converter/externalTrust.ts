/** 외부 JavaScript converter/extension의 실행 신뢰 경계(T030). */

const TRUST_ENVIRONMENT_VARIABLE = "ZIGBEE2MATTER_TRUST_EXTERNAL_JS";
const ALLOWED_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export interface ExternalJSTrustDecision {
    allowed: boolean;
    reason: "trusted" | "disabled" | "invalid-name";
}

/** 운영자가 명시적으로 허용한 경우에만 외부 JavaScript를 import한다. */
export function evaluateExternalJSTrust(name: string, environment: NodeJS.ProcessEnv = process.env): ExternalJSTrustDecision {
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension) || !isSafeFileName(name)) {
        return {allowed: false, reason: "invalid-name"};
    }

    return environment[TRUST_ENVIRONMENT_VARIABLE] === "1"
        ? {allowed: true, reason: "trusted"}
        : {allowed: false, reason: "disabled"};
}

export function externalJSTrustEnvironmentVariable(): string {
    return TRUST_ENVIRONMENT_VARIABLE;
}

function isSafeFileName(name: string): boolean {
    return name.length > 0 && name === name.trim() && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}
