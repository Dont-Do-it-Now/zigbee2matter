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
            exclude: [...coverageConfigDefaults.exclude, "lib/bridgeBus/**", "lib/events/**", "lib/identity/**", "lib/command/**", "lib/matter/**", "lib/api/**"], // z2m-fork: T011 O3
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
