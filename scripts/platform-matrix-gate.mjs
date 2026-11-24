import {readFileSync} from "node:fs";

const path = process.argv[process.argv.indexOf("--evidence") + 1];
const platforms = ["ha-direct", "ha-matter", "smartthings", "apple", "google"];

function fail(message) {
    console.error(`platform gate: ${message}`);
    process.exitCode = 1;
}

if (!path || path.startsWith("--")) {
    fail("platform evidence JSON path is required");
} else {
    let document;
    try {
        document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        fail("platform evidence JSON cannot be read");
        document = undefined;
    }

    for (const platform of platforms) {
        const result = document?.platforms?.[platform];
        if (!result || result.status !== "PASS" || typeof result.evidence !== "string" || result.evidence.trim().length === 0) {
            fail(`${platform} requires non-empty PASS evidence`);
        }
    }
}

if (process.exitCode !== 1) console.log("platform gate: all platform evidence passed");
