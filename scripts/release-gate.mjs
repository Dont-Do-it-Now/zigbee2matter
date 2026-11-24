import {existsSync, readFileSync} from "node:fs";

const requiredFiles = ["lib/security/securityGate.ts", "lib/quality/releaseGate.ts", ".github/workflows/quality.yml"];
const requiredWorkflowEntries = [
    "node scripts/mqtt-free-gate.mjs --strict-test",
    "pnpm install --frozen-lockfile",
    "pnpm run check",
    "pnpm run build",
    "pnpm exec tsc --noEmit",
    "pnpm test",
    "Generate SBOM",
];

function fail(message) {
    console.error(`release gate: ${message}`);
    process.exitCode = 1;
}

for (const file of requiredFiles) {
    if (!existsSync(file)) fail(`required file is missing: ${file}`);
}

const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
for (const entry of requiredWorkflowEntries) {
    if (!workflow.includes(entry)) fail(`required workflow step is missing: ${entry}`);
}

const evidencePath = process.argv[process.argv.indexOf("--release") + 1];
if (process.argv.includes("--release")) {
    if (!evidencePath || evidencePath.startsWith("--")) {
        fail("release evidence JSON path is required");
    } else {
        let evidence;
        try {
            evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        } catch {
            fail("release evidence JSON cannot be read");
            evidence = undefined;
        }

        const phases = ["P0", "P1", "P2", "P3", "P4", "P5"];
        if (evidence?.approvalsComplete !== true) fail("required approvals are incomplete");
        for (const phase of phases) {
            const item = evidence?.phases?.[phase];
            if (!item || item.status !== "PASS" || typeof item.evidence !== "string" || item.evidence.trim().length === 0) {
                fail(`${phase} requires non-empty PASS evidence`);
            }
        }
    }
}

if (process.exitCode !== 1) console.log("release gate: static checks passed");
