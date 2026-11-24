// T007/T076 lockfile contract. Read-only: never rewrites package.json or pnpm-lock.yaml.
// Usage: node scripts/lockfile-recovery.mjs [--json]
import {existsSync, readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const jsonOutput = process.argv.includes("--json");
const manifestPath = join(root, "package.json");
const lockPath = join(root, "pnpm-lock.yaml");
const errors = [];
const warnings = [];
const forbidden = /(^|[\s/'"])(?:mqtt|mqtt-[\w.-]+|[\w.-]+-mqtt|aedes|mosca|mosquitto|emqx|hivemq|vernemq)(?=[$@:/\s'"\n]|$)/i;

if (!existsSync(manifestPath)) errors.push("package.json is missing");
if (!existsSync(lockPath)) errors.push("pnpm-lock.yaml is missing");

let manifestText = "";
if (existsSync(manifestPath)) {
    manifestText = readFileSync(manifestPath, "utf8");
    try {
        const manifest = JSON.parse(manifestText);
        for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            for (const name of Object.keys(manifest[section] ?? {})) {
                if (forbidden.test(name)) errors.push(`${section} contains forbidden package '${name}'`);
            }
        }
    } catch (error) {
        errors.push(`package.json parse failed: ${error.message}`);
    }
}

let lockText = "";
if (existsSync(lockPath)) {
    lockText = readFileSync(lockPath, "utf8");
    const lines = lockText.split(/\r?\n/);
    lines.forEach((line, index) => {
        if (forbidden.test(line)) errors.push(`pnpm-lock.yaml:${index + 1} contains a forbidden MQTT package`);
    });
}

if (manifestText && lockText && !lockText.includes("lockfileVersion:")) warnings.push("lockfileVersion is not declared");
const result = {
    status: errors.length > 0 ? "FAIL" : "PASS",
    errors,
    warnings,
    lockfileSha256: lockText ? createHash("sha256").update(lockText).digest("hex") : undefined,
    recovery: "After approval, restore the last known-good lockfile or run 'pnpm install --lockfile-only'; review the diff, " +
        "then require 'pnpm install --frozen-lockfile'. Never hand-edit the lockfile.",
};

if (jsonOutput) console.log(JSON.stringify(result, null, 2));
else {
    console.log(`lockfile-recovery: ${result.status}`);
    for (const error of errors) console.log(`ERROR ${error}`);
    for (const warning of warnings) console.log(`WARN ${warning}`);
    if (result.lockfileSha256) console.log(`lockfile-sha256: ${result.lockfileSha256}`);
    console.log(`recovery: ${result.recovery}`);
}
process.exit(errors.length > 0 ? 1 : 0);
