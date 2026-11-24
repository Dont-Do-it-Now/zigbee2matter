import {randomUUID} from "node:crypto";

import type EventBus from "../eventBus";
import logger from "../util/logger";
import type {BridgeEvent, BridgeEventType, EventStreamStats, PublishOptions, ReplayResult} from "./types";

export const DEFAULT_CAPACITY = 1000;

type Listener = (event: BridgeEvent) => Promise<void> | void;

/**
 * 기존 EventBus 이벤트를 한 번 정규화해 C4 형식(epoch/sequence)으로 변환하고, 유한 링 버퍼에 보관하며 구독자에게 전달한다.
 * 구독자 예외는 격리된다. 구독자별 큐/backpressure/fanout은 T016/T017 범위(인터페이스: subscribe/replay).
 */
export class EventStream {
    private epochId = randomUUID();
    private seq = 0;
    private buffer: BridgeEvent[] = [];
    private readonly listeners = new Set<Listener>();
    private pending: BridgeEvent[] = [];
    private dispatching = false;
    readonly stats: EventStreamStats = {published: 0, evicted: 0, listenerErrors: 0};

    constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

    get epoch(): string {
        return this.epochId;
    }

    /** 마지막으로 발행된 sequence (snapshot watermark 용). */
    get lastSequence(): number {
        return this.seq;
    }

    /** 기존 EventBus 이벤트 구독을 연결한다. 호출자는 `removeListeners(this)`로 해제한다. */
    attach(eventBus: EventBus): void {
        eventBus.onStateChange(this, (data) => {
            this.publish("delta", entityKey(data.entity), {update: {...data.update}, reason: data.reason});
        });
        // 버튼/액션 등 순간 이벤트: 상태에 병합하지 않고 개별 보존한다.
        eventBus.onDeviceMessage(this, (data) => {
            this.publish("transient", `device/${data.device.ieeeAddr}`, {
                messageType: data.type,
                cluster: data.cluster,
                endpoint: data.endpoint.ID,
                linkquality: data.linkquality,
                data: data.data,
            });
        });
        eventBus.onDeviceJoined(this, (data) => this.inventory(`device/${data.device.ieeeAddr}`, "joined"));
        eventBus.onDeviceInterview(this, (data) => this.inventory(`device/${data.device.ieeeAddr}`, `interview_${data.status}`));
        eventBus.onDeviceLeave(this, (data) => this.inventory(`device/${data.ieeeAddr}`, "leave"));
        eventBus.onEntityRemoved(this, (data) => this.inventory(entityKey(data.entity), "removed"));
        eventBus.onEntityRenamed(this, (data) => this.inventory(entityKey(data.entity), "renamed", {from: data.from, to: data.to}));
        eventBus.onGroupMembersChanged(this, (data) => this.inventory(`group/${data.group.ID}`, `members_${data.action}`));
        eventBus.onDevicesChanged(this, () => this.inventory("bridge", "devices_changed"));
        eventBus.onExposesChanged(this, (data) => this.inventory(`device/${data.device.ieeeAddr}`, "exposes_changed"));
    }

    /**
     * 다른 Core 모듈(명령 결과, availability 등)이 C4 이벤트를 직접 발행한다.
     * 구독자 안에서 재진입 publish 하면 sequence는 즉시 부여되지만 전달은 현재 디스패치 완료 후 순차 처리된다.
     * 저장·전달되는 이벤트와 payload 얕은 복사본(호출자 객체는 건드리지 않음)이 freeze 된다(깊은 복제는 비용 때문에 생략; 중첩 객체는 소비자가 변경하지 않는다고 가정).
     */
    publish<T>(type: BridgeEventType, key: string, payload: T, options: PublishOptions = {}): BridgeEvent<T> {
        const frozen = (typeof payload === "object" && payload !== null ? Object.freeze(Array.isArray(payload) ? [...payload] : {...payload}) : payload) as T;
        const event: BridgeEvent<T> = {epoch: this.epochId, sequence: ++this.seq, type, key, payload: frozen};

        if (options.revision !== undefined) {
            event.revision = options.revision;
        }

        if (options.correlationId !== undefined) {
            event.correlationId = options.correlationId;
        }

        Object.freeze(event);
        this.buffer.push(event);
        this.stats.published += 1;

        if (this.buffer.length > this.capacity) {
            this.buffer.shift();
            this.stats.evicted += 1;
        }

        this.pending.push(event);

        if (!this.dispatching) {
            this.dispatching = true;

            try {
                for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) {
                    this.dispatch(next);
                }
            } finally {
                this.dispatching = false;
            }
        }

        return event;
    }

    private dispatch(event: BridgeEvent): void {
        for (const listener of this.listeners) {
            try {
                const result: unknown = listener(event);

                if (result instanceof Promise) {
                    result.catch((error: unknown) => this.listenerFailed(error));
                }
            } catch (error) {
                this.listenerFailed(error);
            }
        }
    }

    private listenerFailed(error: unknown): void {
        this.stats.listenerErrors += 1;
        logger.error(`EventStream listener error: ${(error as Error).message}`);
    }

    /** attach()로 건 EventBus 구독을 해제한다. 주의: EventBus.removeListeners는 key.constructor.name 기준이라 EventStream 인스턴스가 여러 개면 서로의 구독도 해제된다(단일 인스턴스 전제). */
    detach(eventBus: EventBus): void {
        eventBus.removeListeners(this);
    }

    /** 구독. 반환된 함수로 해제한다. */
    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * `afterSequence` 이후 이벤트를 반환한다. epoch가 다르거나 필요한 이벤트가 버퍼에서 밀려났으면 resync 요구.
     * `epoch`를 생략하면 현재 epoch로 간주한다.
     */
    replay(afterSequence: number, epoch: string = this.epochId): ReplayResult {
        const oldestSequence = this.buffer[0]?.sequence;

        if (!Number.isInteger(afterSequence) || afterSequence < 0) {
            return {resync: true, reason: "invalid", epoch: this.epochId, oldestSequence};
        }

        if (epoch !== this.epochId) {
            return {resync: true, reason: "epoch", epoch: this.epochId, oldestSequence};
        }

        if (afterSequence > this.seq || (afterSequence < this.seq && (oldestSequence === undefined || afterSequence + 1 < oldestSequence))) {
            return {resync: true, reason: "gap", epoch: this.epochId, oldestSequence};
        }

        return {resync: false, events: this.buffer.filter((e) => e.sequence > afterSequence)};
    }

    /**
     * 새 epoch 시작: sequence 초기화, 버퍼 폐기. 모든 소비자는 resync 해야 한다.
     * 구독자 알림: 새 epoch의 첫 이벤트로 type "snapshot", key "bridge", payload {reason: "epochReset"} 를 발행한다(최소안; 소비자는 epoch 변경으로 resync 판단).
     */
    resetEpoch(): string {
        this.epochId = randomUUID();
        this.seq = 0;
        this.buffer = [];
        this.publish("snapshot", "bridge", {reason: "epochReset"});

        return this.epochId;
    }

    private inventory(key: string, change: string, extra?: Record<string, unknown>): void {
        this.publish("inventory", key, {change, ...extra});
    }
}

function entityKey(entity: Device | Group): string {
    return entity.isDevice() ? `device/${entity.ieeeAddr}` : `group/${entity.ID}`;
}
