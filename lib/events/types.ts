/** C4 외부용 이벤트 형식. Core 공용: Matter/HTTP 구현을 import하지 않는다(C5). */

export type BridgeEventType = "snapshot" | "delta" | "transient" | "commandResult" | "availability" | "inventory";

export interface BridgeEvent<T = unknown> {
    /** 프로세스(스트림) 세대. 변경되면 소비자는 resync 해야 한다. */
    epoch: string;
    /** epoch 내 1부터 단조 증가. 건너뛰면 gap. */
    sequence: number;
    type: BridgeEventType;
    /** 대상 식별자. state/delta/availability는 C1 키(`dev:<net>:<ieee>:<ep>:<feature>`, `grp:...`),
     * inventory/transient는 `device/<ieee>`, `group/<id>`, `bridge`. */
    key: string;
    /** 상태 revision(C2, T020/T021 범위). 아직 없으면 undefined. */
    revision?: number;
    correlationId?: string;
    payload: T;
}

export interface PublishOptions {
    revision?: number;
    correlationId?: string;
}

export type ReplayResult =
    | {resync: false; events: BridgeEvent[]}
    | {resync: true; reason: "epoch" | "gap" | "invalid"; epoch: string; oldestSequence: number | undefined};

export interface EventStreamStats {
    published: number;
    /** 유한 버퍼에서 밀려난 이벤트 수. */
    evicted: number;
    listenerErrors: number;
}
