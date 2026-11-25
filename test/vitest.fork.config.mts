import {defineConfig} from "vitest/config";

// 포크 전용 테스트 설정(T011 O3). upstream test/vitest.config.mts 와 분리. 커버리지 임계값은 기준 미정이라 설정하지 않는다.
export default defineConfig({
    plugins: [],
    test: {
        include: ["test/fork/**/*.test.ts"],
        onConsoleLog(_log: string, _type: "stdout" | "stderr"): boolean | undefined {
            return false;
        },
        coverage: {
            enabled: false,
            provider: "v8",
            include: [
                "lib/bridgeBus/**",
                "lib/events/**",
                "lib/identity/**",
                "lib/command/**",
                "lib/matter/**",
                "lib/api/**",
                "lib/converter/**",
                "lib/ha/**",
                "lib/migration/**",
                "lib/ota/**",
                "lib/quality/**",
                "lib/release/**",
                "lib/runtime/**",
                "lib/security/**",
                "lib/state/**",
                "lib/storage/**",
                "lib/extension/commandValidator.ts",
                "lib/extension/matter.ts",
                "lib/availabilityPolicy.ts",
                "lib/connectionRecovery.ts",
                "lib/coordinatorDiscovery.ts",
                "lib/coordinatorReplacement.ts",
                "lib/groupBinding.ts",
                "lib/lifecycle.ts",
                "lib/pairing.ts",
            ],
            extension: [".ts"],
            clean: true,
            cleanOnRerun: true,
            reportsDirectory: "coverage-fork",
            reporter: ["text", "html"],
            reportOnFailure: false,
        },
    },
});
