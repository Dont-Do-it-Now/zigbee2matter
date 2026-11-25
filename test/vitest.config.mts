import {configDefaults, coverageConfigDefaults, defineConfig} from "vitest/config";

export default defineConfig({
    plugins: [],
    test: {
        exclude: [...configDefaults.exclude, "test/fork/**"], // z2m-fork: T011 O3
        onConsoleLog(_log: string, _type: "stdout" | "stderr"): boolean | undefined {
            return false;
        },
        coverage: {
            enabled: false,
            provider: "v8",
            include: ["lib/**"],
            extension: [".ts"],
            exclude: [
                ...coverageConfigDefaults.exclude,
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
            ], // z2m-fork: T011 O3
            clean: true,
            cleanOnRerun: true,
            reportsDirectory: "coverage",
            reporter: ["text", "html"],
            reportOnFailure: false,
            thresholds: {
                100: true,
            },
        },
    },
});
