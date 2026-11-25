// T007 upstream ledger. Read-only: no fetch, merge, branch, commit, or file write.
// Usage: node scripts/upstream-ledger.mjs --base <sha> --candidate <sha> [--json] [--fail-on-review]
import {execFileSync} from "node:child_process";

const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BASE = value("--base") ?? process.env.UPSTREAM_BASE_SHA;
const CANDIDATE = value("--candidate") ?? process.env.UPSTREAM_CANDIDATE_SHA;
const JSON_OUTPUT = args.includes("--json");
const FAIL_ON_REVIEW = args.includes("--fail-on-review");
const SHA = /^[0-9a-f]{40}$/i;

const mixed = new Set([
    "lib/controller.ts",
    "lib/eventBus.ts",
    "lib/extension/extension.ts",
    "lib/extension/bridge.ts",
    "lib/extension/publish.ts",
    "lib/extension/bind.ts",
    "lib/extension/groups.ts",
    "lib/extension/configure.ts",
    "lib/extension/networkMap.ts",
    "lib/extension/otaUpdate.ts",
    "lib/extension/externalJS.ts",
    "lib/extension/frontend.ts",
    "lib/extension/homeassistant.ts",
    "lib/types/api.ts",
    "lib/types/types.d.ts",
    "lib/util/settings.ts",
    "lib/util/settings.schema.json",
    "package.json",
    "pnpm-lock.yaml",
]);
const forkPrefixes = [
    "lib/bridgeBus/",
    "lib/matter/",
    "lib/api/",
    "lib/command/",
    "lib/events/",
    "lib/identity/",
    "lib/state/reconciliation.ts",
    "lib/state/snapshot.ts",
    "lib/migration/",
    "lib/quality/",
    "lib/security/",
    "lib/storage/",
    "scripts/",
    ".github/workflows/",
];
const corePrefixes = ["lib/model/", "test/"];
const mqttPattern = /(^|\/)(mqtt|mosquitto|aedes|mosca|emqx|hivemq|vernemq)([-./]|$)|mqtt/i;

function git(...gitArgs) {
    return execFileSync("git", gitArgs, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
}

function fail(message) {
    if (JSON_OUTPUT) {
        console.log(JSON.stringify({status: "error", message}, null, 2));
    } else {
        console.error(`upstream-ledger: ${message}`);
    }
    process.exit(2);
}

if (!BASE || !CANDIDATE || !SHA.test(BASE) || !SHA.test(CANDIDATE)) {
    fail("base/candidate must be explicit 40-character SHA values");
}

try {
    git("cat-file", "-e", `${BASE}^{commit}`);
    git("cat-file", "-e", `${CANDIDATE}^{commit}`);
} catch {
    fail("base or candidate commit is not present locally; fetch is an explicit caller step");
}

let raw;
let diffRaw;
try {
    raw = git("diff", "--no-ext-diff", "--name-status", "--find-renames", `${BASE}..${CANDIDATE}`);
    diffRaw = git("diff", "--no-ext-diff", "--unified=0", "--find-renames", `${BASE}..${CANDIDATE}`);
} catch {
    fail("unable to calculate the candidate file/hunk diff");
}

function classify(path) {
    if (mqttPattern.test(path)) return {class: "EXCLUDE", decision: "EXCLUDE", reason: "MQTT/broker or MQTT-named path"};
    if (mixed.has(path)) return {class: "MIXED", decision: "REVIEW_REQUIRED", reason: "Core and BridgeBus/MQTT contract share this file"};
    if (forkPrefixes.some((prefix) => path.startsWith(prefix))) {
        return {class: "FORK", decision: "EXCLUDE", reason: "fork/CI-owned path; never overwrite automatically"};
    }
    if (path === "lib/zigbee.ts" || path === "lib/state.ts" || corePrefixes.some((prefix) => path.startsWith(prefix))) {
        return {class: "CORE", decision: "REVIEW_REQUIRED", reason: "upstream Core behavior requires hunk review"};
    }
    return {class: "REVIEW_REQUIRED", decision: "HOLD", reason: "unclassified path requires explicit ledger decision"};
}

const changes =
    raw === ""
        ? []
        : raw.split(/\r?\n/).map((line) => {
              const parts = line.split(/\s+/);
              const status = parts[0];
              const path = parts.at(-1);
              return {status, path, ...classify(path)};
          });
const hunks = [];
let currentPath;
for (const line of diffRaw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
        currentPath = line.match(/ b\/(.*)$/)?.[1];
        continue;
    }
    if (currentPath && line.startsWith("@@")) {
        hunks.push({path: currentPath, hunk: line, ...classify(currentPath)});
    }
}
const reviewRequired = [...changes, ...hunks].filter((change) => change.decision === "REVIEW_REQUIRED" || change.decision === "HOLD");
const result = {
    status: reviewRequired.length > 0 ? "REVIEW_REQUIRED" : "SAFE_TO_STAGE_ONLY",
    base: BASE,
    candidate: CANDIDATE,
    changes,
    hunks,
    recovery: "discard only the staging worktree; preserve base and fork-owned paths; do not merge main automatically",
};

if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
} else {
    console.log(`base: ${BASE}`);
    console.log(`candidate: ${CANDIDATE}`);
    console.log(`status: ${result.status}`);
    for (const change of changes) {
        console.log(`${change.status}\t${change.path}\t${change.class}\t${change.decision}\t${change.reason}`);
    }
    for (const hunk of hunks) {
        console.log(`HUNK\t${hunk.path}\t${hunk.hunk}\t${hunk.class}\t${hunk.decision}\t${hunk.reason}`);
    }
    console.log(`recovery: ${result.recovery}`);
}

if (FAIL_ON_REVIEW && reviewRequired.length > 0) process.exit(1);
