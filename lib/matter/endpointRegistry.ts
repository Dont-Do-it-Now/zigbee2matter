/**
 * Matter endpoint 영속 매핑 레지스트리 (T036, CONTRACTS C1).
 *
 * 브리지(BridgeId)별로 EntityKey(`dev:...`/`grp:...`, lib/identity) -> SDK endpoint id 문자열을 영속 매핑한다.
 * Matter endpoint *number* 는 SDK 가 endpoint id 경로 기준으로 영속 할당/재사용하므로(`__nextNumber__` 단조 증가 카운터) 재구현하지 않는다.
 * number 는 진단용 관측값으로만 기록한다. 근거: docs/evidence/T036.md
 *
 * SDK(@matter/*)를 import 하지 않는다. 파일 저장 구현은 T061 (`EndpointRegistryStore` 구현 담당). Core 에서 import 금지 (C5).
 */
import {type BridgeId, type DeviceKey, formatDeviceKey, formatGroupKey, type GroupKey, parseBridgeId, parseEntityKey} from "../identity";

export const ENDPOINT_REGISTRY_VERSION = 1;

/** SDK `Endpoint` id 로 쓰는 문자열 접두. 같은 owner(Aggregator) 아래에서 유일해야 한다. */
export const ENDPOINT_ID_PREFIX = "z2m-";

const ENDPOINT_ID_RE = /^z2m-([1-9][0-9]*)$/;
/** 부분(part) endpoint number 범위 (0=root, 0xffff 제외). 진단용 검증에만 사용. */
const MAX_PART_NUMBER = 0xfffe;

export type EndpointEntryState = "active" | "removed";

export interface EndpointRegistryEntry {
    /** `formatDeviceKey`/`formatGroupKey` 결과. 같은 key 에 removed 여러 개 + active 최대 1개가 존재할 수 있다. */
    key: string;
    /** SDK Endpoint id. 한번 발급되면 다른 key/세대에 재할당되지 않는다. */
    endpointId: string;
    /** `removed` = tombstone. endpointId 는 영구 예약(재사용 금지). */
    state: EndpointEntryState;
    /** SDK 가 마지막으로 할당한 것으로 관측된 endpoint number (선택, 진단용). */
    number?: number;
}

/** 직렬화 포맷 v1. */
export interface EndpointRegistryDocument {
    version: typeof ENDPOINT_REGISTRY_VERSION;
    bridgeId: string;
    /** 다음에 발급할 endpoint id 순번. 단조 증가, 감소 금지. */
    nextSeq: number;
    entries: EndpointRegistryEntry[];
}

/** 저장 인터페이스. 구현(파일, 원자적 쓰기, 락)은 T061 소유. */
export interface EndpointRegistryStore {
    /** 문서가 없으면 undefined. 손상/미지원 버전은 throw. */
    load(bridgeId: BridgeId): Promise<EndpointRegistryDocument | undefined>;
    /** resolve 이후에만 영속된 것으로 간주한다. 실패 시 throw. */
    save(bridgeId: BridgeId, document: EndpointRegistryDocument): Promise<void>;
}

/** 테스트/임시용 메모리 구현. JSON 왕복을 거쳐 참조 공유를 막는다. */
export class MemoryEndpointRegistryStore implements EndpointRegistryStore {
    #data = new Map<string, string>();

    load(bridgeId: BridgeId): Promise<EndpointRegistryDocument | undefined> {
        try {
            const raw = this.#data.get(bridgeId);

            return Promise.resolve(raw === undefined ? undefined : parseEndpointRegistryDocument(JSON.parse(raw), bridgeId));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    save(bridgeId: BridgeId, document: EndpointRegistryDocument): Promise<void> {
        try {
            this.#data.set(bridgeId, JSON.stringify(document));

            return Promise.resolve();
        } catch (error) {
            return Promise.reject(error);
        }
    }
}

export type RejoinPolicy = "new-id" | "restore";

export interface EndpointRegistryOptions {
    /**
     * tombstone 만 있는 key 가 다시 `ensure` 될 때의 정책 (OPEN QUESTION, T019 OQ2).
     * - `new-id`(기본): 새 endpointId 발급. 이전 id 는 영구 예약.
     * - `restore`: 가장 최근 tombstone 의 endpointId 를 되살림. 단 SDK `Endpoint.delete()` 는 저장된 number 도 지우므로 number 는 새로 할당된다.
     */
    rejoin?: RejoinPolicy;
}

export interface NumberObservation {
    /** 이전에 기록된 number 와 다르면 true (첫 기록은 false). */
    changed: boolean;
    previous?: number;
}

export interface EndpointConsistencyIssue {
    readonly key: string;
    readonly endpointId: string;
    readonly issue: "missing-sdk-endpoint" | "unexpected-sdk-endpoint";
}

export type RegistryKey = DeviceKey | GroupKey | string;

function keyString(key: RegistryKey): string {
    if (typeof key === "string") {
        return key;
    }

    return "groupId" in key ? formatGroupKey(key) : formatDeviceKey(key);
}

function seqOfEndpointId(endpointId: string): number | undefined {
    const match = ENDPOINT_ID_RE.exec(endpointId);

    return match ? Number(match[1]) : undefined;
}

function isPartNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PART_NUMBER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 직렬화 문서 검증. 손상/미지원은 조용히 보정하지 않고 throw 한다(ID 중복 방지가 우선).
 * `expectedBridgeId` 가 주어지면 문서의 bridgeId 와 일치해야 한다.
 */
export function parseEndpointRegistryDocument(raw: unknown, expectedBridgeId?: BridgeId): EndpointRegistryDocument {
    if (!isRecord(raw)) {
        throw new Error("endpoint registry: document is not an object");
    }

    if (raw.version !== ENDPOINT_REGISTRY_VERSION) {
        throw new Error(`endpoint registry: unsupported version ${String(raw.version)}`);
    }

    const bridgeId = typeof raw.bridgeId === "string" ? parseBridgeId(raw.bridgeId) : undefined;

    if (bridgeId === undefined || (expectedBridgeId !== undefined && bridgeId !== expectedBridgeId)) {
        throw new Error("endpoint registry: bridgeId missing, invalid or mismatched");
    }

    const nextSeq = raw.nextSeq;

    if (typeof nextSeq !== "number" || !Number.isSafeInteger(nextSeq) || nextSeq < 1 || !Array.isArray(raw.entries)) {
        throw new Error("endpoint registry: invalid nextSeq or entries");
    }

    const activeKeys = new Set<string>();
    const ids = new Set<string>();
    const activeNumbers = new Set<number>();
    const entries: EndpointRegistryEntry[] = [];

    for (const item of raw.entries as unknown[]) {
        if (!isRecord(item) || typeof item.key !== "string" || typeof item.endpointId !== "string") {
            throw new Error("endpoint registry: invalid entry");
        }

        const {key, endpointId, state, number} = item;
        const seq = seqOfEndpointId(endpointId);

        if (parseEntityKey(key) === undefined || seq === undefined || seq >= nextSeq) {
            throw new Error(`endpoint registry: invalid key or endpointId in entry ${key}`);
        }

        if (state !== "active" && state !== "removed") {
            throw new Error(`endpoint registry: invalid state in entry ${key}`);
        }

        if (number !== undefined && !isPartNumber(number)) {
            throw new Error(`endpoint registry: invalid number in entry ${key}`);
        }

        if (ids.has(endpointId) || (state === "active" && activeKeys.has(key))) {
            throw new Error(`endpoint registry: duplicate endpointId or active key in entry ${key}`);
        }

        if (state === "active") {
            activeKeys.add(key);

            if (number !== undefined) {
                if (activeNumbers.has(number)) {
                    throw new Error(`endpoint registry: duplicate active number ${number}`);
                }

                activeNumbers.add(number);
            }
        }

        ids.add(endpointId);
        entries.push(number === undefined ? {key, endpointId, state} : {key, endpointId, state, number});
    }

    return {version: ENDPOINT_REGISTRY_VERSION, bridgeId, nextSeq, entries};
}

/**
 * 브리지 하나의 EntityKey -> endpoint id 영속 레지스트리.
 *
 * 변경 메서드는 저장 성공 후에만 resolve 한다 (write-ahead): SDK endpoint 를 만들기 전에 `ensure()` 를 await 하면
 * crash 시 최악의 경우 사용되지 않은 id 가 남을 뿐 중복 id 는 생기지 않는다. 저장 실패 시 메모리 상태를 되돌리고 throw 한다.
 * 변경은 내부 큐로 직렬화된다.
 */
export class EndpointRegistry {
    readonly bridgeId: BridgeId;
    #store: EndpointRegistryStore;
    #rejoin: RejoinPolicy;
    #active = new Map<string, EndpointRegistryEntry>();
    #removed: EndpointRegistryEntry[] = [];
    #nextSeq = 1;
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(bridgeId: BridgeId, store: EndpointRegistryStore, rejoin: RejoinPolicy) {
        this.bridgeId = bridgeId;
        this.#store = store;
        this.#rejoin = rejoin;
    }

    /** 저장소에서 로드(없으면 빈 레지스트리, 첫 변경 시 저장). */
    static async open(bridgeId: BridgeId, store: EndpointRegistryStore, options: EndpointRegistryOptions = {}): Promise<EndpointRegistry> {
        const rejoin = options.rejoin ?? "new-id";
        if (rejoin !== "new-id" && rejoin !== "restore") {
            throw new Error(`endpoint registry: unsupported rejoin policy ${String(rejoin)}`);
        }
        const registry = new EndpointRegistry(bridgeId, store, rejoin);
        const document = await store.load(bridgeId);

        if (document !== undefined) {
            registry.#restoreFrom(parseEndpointRegistryDocument(document, bridgeId));
        }

        return registry;
    }

    /** active 엔트리만 반환(복사본). */
    get(key: RegistryKey): EndpointRegistryEntry | undefined {
        const entry = this.#active.get(keyString(key));

        return entry ? {...entry} : undefined;
    }

    /** active + tombstone 전체 (복사본). */
    list(): EndpointRegistryEntry[] {
        return [...this.#active.values(), ...this.#removed].map((entry) => ({...entry}));
    }

    /** SDK node의 현재 endpoint id 집합과 비교한다. 어느 쪽도 자동 삭제·복구하지 않는다. */
    findConsistencyIssues(sdkEndpointIds: readonly string[]): EndpointConsistencyIssue[] {
        const sdkIds = new Set(sdkEndpointIds);
        const issues: EndpointConsistencyIssue[] = [];
        for (const entry of this.#active.values()) {
            if (!sdkIds.has(entry.endpointId)) issues.push({key: entry.key, endpointId: entry.endpointId, issue: "missing-sdk-endpoint"});
        }
        const known = new Set(this.#active.values().map((entry) => entry.endpointId));
        for (const endpointId of sdkIds) {
            if (!known.has(endpointId)) issues.push({key: "unknown", endpointId, issue: "unexpected-sdk-endpoint"});
        }
        return issues;
    }

    /** 저장 포맷으로 직렬화. */
    serialize(): EndpointRegistryDocument {
        return {version: ENDPOINT_REGISTRY_VERSION, bridgeId: this.bridgeId, nextSeq: this.#nextSeq, entries: this.list()};
    }

    /** Restores a validated document and persists it through the registry store. */
    async restore(document: EndpointRegistryDocument): Promise<void> {
        const parsed = parseEndpointRegistryDocument(document, this.bridgeId);
        await this.#mutate(() => {
            this.#active.clear();
            this.#removed = [];
            this.#restoreFrom(parsed);
        });
    }

    /** active 면 기존 매핑 그대로. 없으면 발급(또는 정책에 따라 복원)하고 저장 후 반환. 잘못된 key 는 throw. */
    async ensure(key: RegistryKey): Promise<EndpointRegistryEntry> {
        const keyStr = keyString(key);

        if (parseEntityKey(keyStr) === undefined) {
            throw new Error(`endpoint registry: invalid entity key ${keyStr}`);
        }

        return await this.#mutate(() => {
            const existing = this.#active.get(keyStr);

            if (existing !== undefined) {
                return {...existing};
            }

            const tombstoneIndex = this.#rejoin === "restore" ? this.#removed.findLastIndex((entry) => entry.key === keyStr) : -1;
            const [tombstone] = tombstoneIndex >= 0 ? this.#removed.splice(tombstoneIndex, 1) : [];
            const endpointId = tombstone?.endpointId ?? this.#issueId();
            // 복원 시 이전 number 는 SDK 에서 이미 해제됨(delete() 가 저장소를 지움) -> 버린다.
            const entry: EndpointRegistryEntry = {key: keyStr, endpointId, state: "active"};

            this.#active.set(keyStr, entry);

            return {...entry};
        });
    }

    /** SDK `Endpoint.delete()` 로 영속 데이터까지 제거한 key 를 tombstone 처리. active 가 없으면 false. (`close()` 일시 제거에는 호출하지 않는다.) */
    async markRemoved(key: RegistryKey): Promise<boolean> {
        const keyStr = keyString(key);

        return await this.#mutate(() => {
            const entry = this.#active.get(keyStr);

            if (entry === undefined) {
                return false;
            }

            this.#active.delete(keyStr);
            this.#removed.push({key: entry.key, endpointId: entry.endpointId, state: "removed"});

            return true;
        });
    }

    /** SDK 가 할당한 endpoint number 를 기록(진단용). active 가 없으면 throw. 다른 active 가 같은 number 를 가지면 throw. */
    async recordNumber(key: RegistryKey, number: number): Promise<NumberObservation> {
        const keyStr = keyString(key);

        return await this.#mutate(() => {
            const entry = this.#active.get(keyStr);

            if (entry === undefined) {
                throw new Error(`endpoint registry: no active entry for ${keyStr}`);
            }

            if (!isPartNumber(number)) {
                throw new Error(`endpoint registry: invalid endpoint number ${number}`);
            }

            for (const other of this.#active.values()) {
                if (other !== entry && other.number === number) {
                    throw new Error(`endpoint registry: number ${number} already recorded for ${other.key}`);
                }
            }

            const previous = entry.number;

            entry.number = number;

            return previous === undefined ? {changed: false} : {changed: previous !== number, previous};
        });
    }

    #issueId(): string {
        const id = `${ENDPOINT_ID_PREFIX}${this.#nextSeq}`;

        this.#nextSeq += 1;

        return id;
    }

    #restoreFrom(document: EndpointRegistryDocument): void {
        this.#nextSeq = document.nextSeq;

        for (const entry of document.entries) {
            if (entry.state === "active") {
                this.#active.set(entry.key, {...entry});
            } else {
                this.#removed.push({key: entry.key, endpointId: entry.endpointId, state: "removed"});
            }
        }
    }

    /** 변경 -> 저장. 큐로 직렬화하고, 저장 실패 시 이전 상태로 롤백. */
    #mutate<T>(change: () => T): Promise<T> {
        const run = async (): Promise<T> => {
            const before = this.serialize();

            try {
                const result = change();

                await this.#store.save(this.bridgeId, this.serialize());

                return result;
            } catch (error) {
                this.#active.clear();
                this.#removed = [];
                this.#restoreFrom(before);

                throw error;
            }
        };
        const next = this.#queue.then(run, run);

        this.#queue = next.catch(() => {});

        return next;
    }
}
