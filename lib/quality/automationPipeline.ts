/** CI에서 실행할 검증 순서와 권한 범위를 생성하는 계약(T076). */

export interface PipelineStep {
    readonly id: string;
    readonly command: string;
    readonly permissions: readonly string[];
    readonly required: boolean;
}

export interface PipelinePlan {
    readonly trigger: "pull_request" | "push" | "release";
    readonly steps: readonly PipelineStep[];
}

export function createPipelinePlan(trigger: PipelinePlan["trigger"]): PipelinePlan {
    const common: PipelineStep[] = [
        {id: "source-integrity", command: "upstream ledger review", permissions: ["contents:read"], required: true},
        {id: "quality", command: "pnpm run check", permissions: ["contents:read"], required: true},
        {id: "typecheck", command: "pnpm exec tsc --noEmit", permissions: ["contents:read"], required: true},
        {id: "tests", command: "pnpm test", permissions: ["contents:read"], required: true},
        {id: "security-gate", command: "security and secret-redaction gate", permissions: ["contents:read"], required: true},
    ];
    if (trigger === "release") {
        common.push({id: "sbom", command: "generate and verify SBOM", permissions: ["contents:read"], required: true});
        common.push({id: "release-approval", command: "manual release approval", permissions: ["contents:read"], required: true});
    }
    return {trigger, steps: common};
}
