/**
 * matter.js 저장소의 BigInt 직렬화 보호와 기존 손상 데이터 복구.
 *
 * 원인: zigbee-herdsman이 `BigInt.prototype.toJSON`을 전역으로 패치(utils/patchBigIntSerialization.js)한다.
 * `JSON.stringify`는 replacer보다 toJSON을 먼저 호출하므로, matter.js `toJson`의 replacer가 bigint를 보지 못하고
 * 일반 문자열("2")로 저장된다. 재시작 시 fabricId/ACL subjects 등이 문자열로 읽혀 node 초기화가 실패한다.
 */
import {randomUUID} from "node:crypto";
import {readdir, readFile, rename, writeFile} from "node:fs/promises";
import {join} from "node:path";

interface MatterJson {
    toJson(value: unknown, spaces?: number): string;
    fromJson(json: string): unknown;
}

type GuardedToJson = ((this: bigint) => unknown) & {matterGuard?: true};

const MATTER_STACK = /StringifyTools|\btoJson\b/;

/** matter.js `toJson` 안에서 호출될 때만 bigint를 그대로 돌려줘 replacer가 인코딩하게 한다. 그 외(herdsman 로그 등)는 기존 동작 유지. */
export function guardMatterBigIntJson(): void {
    const proto = BigInt.prototype as unknown as {toJSON?: GuardedToJson};
    const previous = proto.toJSON;
    if (!previous || previous.matterGuard) return;
    const guarded: GuardedToJson = function (this: bigint) {
        return MATTER_STACK.test(new Error().stack ?? "") ? this : previous.call(this);
    };
    guarded.matterGuard = true;
    proto.toJSON = guarded;
}

const BIGINT_KEYS = new Set(["fabricId", "nodeId", "rootNodeId", "globalId", "peerNodeId"]);
/** 값 전체가 bigint인 키 파일(`<contexts>.<key>`). */
const BIGINT_FILES = new Set(["events.lastEventNumber", "root.generalCommissioning.breadcrumb"]);
const DECIMAL = /^\d+$/;

let converted = false;

function toBigInt(value: unknown): unknown {
    if (typeof value !== "string" || !DECIMAL.test(value)) return value;
    converted = true;
    return BigInt(value);
}

function fix(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) return value.map((item) => (key === "subjects" ? toBigInt(item) : fix(item)));
    if (value && typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof Map)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, BIGINT_KEYS.has(k) ? toBigInt(v) : fix(v, k)]));
    }
    return value;
}

/** `directory`(node별 저장소)의 손상된 값(bigint가 십진 문자열로 저장됨)을 matter.js 형식으로 되돌린다. 수정한 파일 수를 반환. */
export async function repairBigIntStorage(directory: string, json: MatterJson): Promise<number> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
    let repaired = 0;
    for (const name of names) {
        if (name === "driver.json" || name.endsWith(".tmp")) continue;
        const path = join(directory, name);
        let value: unknown;
        try {
            value = json.fromJson(await readFile(path, "utf8"));
        } catch {
            continue;
        }
        converted = false;
        const fixed = BIGINT_FILES.has(decodeURIComponent(name)) ? toBigInt(value) : fix(value);
        if (!converted) continue;
        const next = json.toJson(fixed);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, next, "utf8");
        await rename(temporary, path);
        repaired++;
    }
    return repaired;
}
