// T072 MQTT-free gate. Node 표준 라이브러리만 사용, 읽기 전용(파일 쓰기/네트워크/git 없음).
// 사용: node scripts/mqtt-free-gate.mjs [--root <dir>] [--json] [--strict-test]
// exit 0 = 위반 없음, 1 = 위반, 2 = 게이트 자체 오류. 허용 목록: scripts/mqtt-free-gate.allowlist.json
import {existsSync, lstatSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

// 예상 밖 예외(잘못된 정규식, 파일 읽기 실패 등)는 위반(1)과 구분되는 게이트 오류(2)
process.on("uncaughtException", (e) => {
    console.error(`GATE ERROR: ${e?.stack ?? e}`);
    process.exit(2);
});
const args = process.argv.slice(2);
const argVal = (name) => {
    if (!args.includes(name)) return undefined;
    const v = args[args.indexOf(name) + 1];
    if (!v || v.startsWith("--")) {
        console.error(`GATE ERROR: ${name} 값 누락`);
        process.exit(2);
    }
    return v;
};
const ROOT = argVal("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const AS_JSON = args.includes("--json");
const STRICT_TEST = args.includes("--strict-test");

// 금지 패키지: mqtt 클라이언트/브로커. 허용 패키지는 allowlist.allowedPackages (브랜드 이름 zigbee2mqtt*).
const FORBIDDEN_PKG = new RegExp(
    "^(@[\\w.-]+\\/)?(mqtt\\d*|mqtt[_.-].+|.+[-_.]mqtt\\d*|async-mqtt|paho-mqtt|aedes(-.+)?|mosca|" +
        "mosquitto(-.+)?|emqx(-.+)?|hivemq(-.+)?|vernemq(-.+)?)$",
    "i",
);
const FORBIDDEN_PKG_PREFIX = /^@[^/]*(mqtt|emqx|aedes|hivemq|vernemq)[^/]*\//i;
// 하드 금지(코드 패턴): 허용 목록으로 풀 수 없다.
const HARD_BAN = [
    [/\bthis\.mqtt\b/, "this.mqtt"],
    [/\bmqtt\.(publish|subscribe|unsubscribe|connect)\w*\(/i, "mqtt.publish/subscribe/connect("],
    [/\bmqtts?:\/\//i, "mqtt:// URL"],
    [/\bMQTT(Message|Client|Connection)\w*/, "MQTTMessage/MQTTClient 식별자"],
    [/\b(Mqtt|MQTT)(Client|Broker|Server)\b/, "Mqtt client/broker 식별자"],
];
const IDENT = /mqtt|mosquitto|\baedes\b|\bmosca\b|emqx|hivemq|vernemq/i;
const BRAND = /zigbee2mqtt/gi;
const TEXT_EXT = /\.(ts|mts|cts|js|mjs|cjs|json|ya?ml|sh|md|toml|env|conf)$|(^|\/)Dockerfile$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "docs"]);
const SELF = /^scripts\/mqtt-free-gate\./;

const violations = [];
const warnings = [];
const add = (rule, file, line, msg, arr = violations) => arr.push({rule, file, line, msg});
const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue; // 심볼릭 링크는 따라가지 않음
        if (st.isDirectory()) walk(p, out);
        else if (st.size < 2_000_000 && TEXT_EXT.test(rel(p))) out.push(p);
    }
    return out;
}
const lines = (p) => readFileSync(p, "utf8").split(/\r?\n/);

let allow;
try {
    allow = JSON.parse(readFileSync(join(ROOT, "scripts/mqtt-free-gate.allowlist.json"), "utf8"));
} catch (e) {
    console.error(`GATE ERROR: allowlist 읽기 실패: ${e.message}`);
    process.exit(2);
}
const allowedPkgs = new Set(allow.allowedPackages ?? []);
for (const r of allow.rules ?? []) {
    if (!Number.isInteger(r.max) || r.max < 0) {
        console.error(`GATE ERROR: allowlist 규칙 max는 0 이상의 정수 필수: ${r.file} ${r.category}`);
        process.exit(2);
    }
}
const rules = (allow.rules ?? []).map((r) => ({...r, re: r.pattern ? new RegExp(r.pattern, "i") : null, hits: 0}));
const isForbiddenPkg = (n) => !allowedPkgs.has(n) && (FORBIDDEN_PKG.test(n) || FORBIDDEN_PKG_PREFIX.test(n));

// (A1) package.json 의존성
try {
    const text = readFileSync(join(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    const src = text.split(/\r?\n/);
    const names = new Set();
    for (const f of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
        Object.keys(pkg[f] ?? {}).forEach((n) => {
            names.add(n);
        });
    for (const f of [pkg.pnpm?.overrides, pkg.overrides, pkg.resolutions])
        Object.keys(f ?? {}).forEach((n) => {
            names.add(n);
        });
    for (const n of names) {
        if (!isForbiddenPkg(n)) continue;
        const ln = src.findIndex((l) => l.includes(`"${n}"`)) + 1;
        add("A1-package.json", "package.json", ln, `금지 MQTT 패키지 '${n}'`);
    }
} catch (e) {
    add("A1-package.json", "package.json", 0, `읽기/파싱 실패: ${e.message}`);
}

// (A2) pnpm-workspace.yaml + pnpm-lock.yaml (importers/packages/snapshots 키 전부)
for (const f of ["pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const seen = new Set();
    lines(p).forEach((l, i) => {
        const m = /^\s*(?:-\s+)?['"]?((?:@[\w.-]+\/)?[\w.-]+?)(?:@[^:'"\s]+)?['"]?:(?:\s|$)/.exec(l);
        if (!m || !isForbiddenPkg(m[1]) || seen.has(m[1])) return;
        seen.add(m[1]);
        const hint = f === "pnpm-lock.yaml" ? " -> lockfile 재생성 필요(package.json에서 제거 후 lockfile 재생성, 사용자 승인 필요)" : "";
        add("A2-lockfile", f, i + 1, `금지 MQTT 패키지 '${m[1]}'${hint}`);
    });
}

// (B) lib/** import/require (+ index.js, cli.js, scripts). test/** 는 기본 경고(--strict-test 시 위반)
// 파일 전체 텍스트 매칭(줄 나뉨 허용): from "x", import("x"), require("x"), import "x", createRequire(...)("x"), 백틱 리터럴
const IMPORT_RE = /(?:\b(?:from|import)\s*["']([^"'\n]+)["'])|(?:(?:\bimport\s*\(|\brequire\s*\(|\)\s*\()\s*["'`]([^"'`$\n]+)["'`])/g;
const pkgOf = (spec) =>
    spec.startsWith(".") || spec.startsWith("node:")
        ? null
        : spec
              .split("/")
              .slice(0, spec.startsWith("@") ? 2 : 1)
              .join("/");
const importFiles = [
    ...walk(join(ROOT, "lib")),
    ...["index.js", "cli.js"].map((f) => join(ROOT, f)).filter(existsSync),
    ...walk(join(ROOT, "scripts")).filter((p) => !SELF.test(rel(p))),
];
const testFiles = walk(join(ROOT, "test"));
for (const [files, target] of [
    [importFiles, violations],
    [testFiles, STRICT_TEST ? violations : warnings],
]) {
    for (const p of files) {
        if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(p)) continue;
        const text = readFileSync(p, "utf8");
        const lineOf = (idx) => text.slice(0, idx).split("\n").length;
        IMPORT_RE.lastIndex = 0;
        // biome-ignore lint/suspicious/noAssignInExpressions: intentional pattern in gate script
        for (let m; (m = IMPORT_RE.exec(text)); ) {
            const spec = m[1] ?? m[2];
            const n = pkgOf(spec);
            if (n && isForbiddenPkg(n)) add("B-import", rel(p), lineOf(m.index), `금지 MQTT 모듈 import '${spec}'`, target);
        }
        const mock = /vi\.mock\(\s*["'`]mqtt/g;
        // biome-ignore lint/suspicious/noAssignInExpressions: intentional pattern in gate script
        for (let m; (m = mock.exec(text)); ) add("B-import", rel(p), lineOf(m.index), "vi.mock('mqtt') 잔존", target);
    }
}

// (B2) lib 내 mqtt 이름 파일
for (const p of walk(join(ROOT, "lib")))
    if (/mqtt/i.test(p.split(sep).pop().replace(BRAND, ""))) add("B-file", rel(p), 0, "lib에 mqtt 이름 파일 존재");

// (C) settings schema / example config
(() => {
    const sp = join(ROOT, "lib/util/settings.schema.json");
    const visit = (node, path) => {
        // biome-ignore lint/suspicious/useIterableCallbackReturn: intentional pattern in gate script
        if (Array.isArray(node)) return node.forEach((v, i) => visit(v, `${path}[${i}]`));
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node.required) && node.required.includes("mqtt"))
            add("C-schema", "lib/util/settings.schema.json", 0, `${path}.required 에 'mqtt'`);
        if (typeof node.$ref === "string" && /mqtt/i.test(node.$ref.replace(BRAND, "")))
            add("C-schema", "lib/util/settings.schema.json", 0, `${path}.$ref '${node.$ref}'`);
        for (const [k, v] of Object.entries(node)) {
            if ((path.endsWith(".properties") || path.endsWith("$defs") || path.endsWith("definitions")) && k.toLowerCase() === "mqtt") {
                add("C-schema", "lib/util/settings.schema.json", 0, `${path}.${k} mqtt 섹션/정의 재등장`);
            }
            visit(v, `${path}.${k}`);
        }
    };
    try {
        visit(JSON.parse(readFileSync(sp, "utf8")), "$");
    } catch (e) {
        add("C-schema", "lib/util/settings.schema.json", 0, `읽기/파싱 실패: ${e.message}`);
    }
    const ex = join(ROOT, "data/configuration.example.yaml");
    if (existsSync(ex))
        // biome-ignore lint/suspicious/useIterableCallbackReturn: intentional pattern in gate script
        lines(ex).forEach((l, i) => /^mqtt\s*:/.test(l) && add("C-schema", "data/configuration.example.yaml", i + 1, "최상위 'mqtt:' 섹션 재등장"));
})();

// (D) 식별자/문자열 잔존: 하드 금지 -> 브랜드 제거 -> 마커 주석 -> allowlist
const scanFiles = [
    ...walk(join(ROOT, "lib")),
    ...walk(join(ROOT, "docker")),
    ...walk(join(ROOT, "data")),
    ...walk(join(ROOT, "scripts")).filter((p) => !SELF.test(rel(p))),
    ...walk(join(ROOT, ".github/workflows")),
    ...["package.json", "index.js", "cli.js"].map((f) => join(ROOT, f)).filter(existsSync),
];
const MARKER = "z2m-fork:";
for (const p of scanFiles) {
    const f = rel(p);
    // biome-ignore lint/suspicious/useIterableCallbackReturn: intentional pattern in gate script
    lines(p).forEach((raw, i) => {
        const l = raw.replace(BRAND, "");
        for (const [re, label] of HARD_BAN) {
            if (re.test(l)) return add("D-hard", f, i + 1, `하드 금지 패턴(${label}): ${raw.trim().slice(0, 120)}`);
        }
        if (!IDENT.test(l)) return;
        const mk = raw.indexOf(MARKER);
        if (mk >= 0 && !IDENT.test(raw.slice(0, mk).replace(BRAND, ""))) return; // mqtt가 마커 주석 안에만 있음
        const rule = rules.find((r) => r.file === f && (!r.re || r.re.test(raw)));
        if (rule) {
            rule.hits++;
            return;
        }
        add("D-ident", f, i + 1, `허용 목록에 없는 MQTT 잔존: ${raw.trim().slice(0, 120)}`);
    });
}
for (const r of rules) {
    if (r.hits > r.max) add("D-ident", r.file, 0, `허용 한도 초과: '${r.category}' ${r.hits} > max ${r.max} (신규 mqtt 문자열 유입)`);
    if (r.hits === 0) add("D-stale", r.file, 0, `미사용 allowlist 항목(삭제 검토): ${r.category} ${r.pattern ?? ""}`, warnings);
}

// 출력
if (AS_JSON) console.log(JSON.stringify({violations, warnings}, null, 2));
else {
    for (const v of violations) console.log(`VIOLATION [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ""} ${v.msg}`);
    for (const w of warnings) console.log(`WARN [${w.rule}] ${w.file}${w.line ? `:${w.line}` : ""} ${w.msg}`);
    const hint = STRICT_TEST ? "" : " (test/** 는 경고, --strict-test 로 승격)";
    console.log(`mqtt-free-gate: ${violations.length} violation(s), ${warnings.length} warning(s)${hint}`);
}
process.exit(violations.length ? 1 : 0);
