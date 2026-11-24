import logger from "../util/logger";

/** 외부 JavaScript converter/extension의 실행 신뢰 경계(T030). upstream 동작(로드 허용) + 경고 로그. */

const TRUST_ENVIRONMENT_VARIABLE = "ZIGBEE2MATTER_TRUST_EXTERNAL_JS";
const ALLOWED_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export interface ExternalJSTrustDecision {
    allowed: boolean;
    reason: "trusted" | "unverified" | "invalid-name";
}

const warned = new Set<string>();

/** 외부 JavaScript는 upstream과 같이 허용하되, 명시적 신뢰 설정이 없으면 경고를 남긴다. */
export function evaluateExternalJSTrust(name: string, environment: NodeJS.ProcessEnv = process.env): ExternalJSTrustDecision {
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension) || !isSafeFileName(name)) {
        return {allowed: false, reason: "invalid-name"};
    }

    if (environment[TRUST_ENVIRONMENT_VARIABLE] === "1") return {allowed: true, reason: "trusted"};

    if (!warned.has(name)) {
        warned.add(name);
        logger.warning(
            `External JavaScript '${name}' runs with full process privileges. ` +
                `Only use code you trust (${TRUST_ENVIRONMENT_VARIABLE}=1 silences this warning).`,
        );
    }

    return {allowed: true, reason: "unverified"};
}

export function externalJSTrustEnvironmentVariable(): string {
    return TRUST_ENVIRONMENT_VARIABLE;
}

function isSafeFileName(name: string): boolean {
    return (
        name.length > 0 &&
        name === name.trim() &&
        name !== "." &&
        name !== ".." &&
        !name.includes("/") &&
        !name.includes("\\") &&
        !name.includes("\0")
    );
}
