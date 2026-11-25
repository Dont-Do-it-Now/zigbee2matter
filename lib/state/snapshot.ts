import type {EventStream} from "../events";
import type StateReconciler from "./reconciliation";
import type {StateRecord} from "./reconciliation";

export interface StateSnapshot {
    epoch: string;
    watermark: number;
    revision: number;
    records: StateRecord[];
}

/** T021 single-writer bridge between C2 state and the C4 EventStream. */
export default class StateSnapshotCoordinator {
    constructor(
        private readonly state: StateReconciler,
        private readonly stream: EventStream,
    ) {}

    observe(key: string, value: unknown, observedAt?: number): StateRecord {
        return this.publishDelta(this.state.observe(key, value, observedAt));
    }

    estimate(key: string, value: unknown): StateRecord {
        return this.publishDelta(this.state.estimate(key, value));
    }

    desire(key: string, value: unknown): StateRecord {
        return this.publishDelta(this.state.desire(key, value));
    }

    markUnavailable(key: string): StateRecord {
        return this.publishAvailability(this.state.markUnavailable(key));
    }

    markAvailable(key: string): StateRecord {
        return this.publishAvailability(this.state.markAvailable(key));
    }

    markUnknown(key: string): StateRecord {
        return this.publishAvailability(this.state.markUnknown(key));
    }

    remove(key: string): boolean {
        const removed = this.state.remove(key);
        if (removed) {
            this.stream.publish("delta", key, {removed: true}, {revision: this.state.lastRevision});
        }

        return removed;
    }

    /** T021: 이벤트를 발행하지 않는 조회. watermark는 현재 마지막 sequence이므로 이후 delta만 적용하면 된다. */
    peek(): StateSnapshot {
        return {epoch: this.stream.epoch, watermark: this.stream.lastSequence, revision: this.state.lastRevision, records: this.state.list()};
    }

    /** 스트림에 snapshot 이벤트를 발행한다(epoch reset·resync 용). 조회에는 `peek()`를 쓴다. */
    publishSnapshot(): StateSnapshot {
        const records = this.state.list();
        const revision = this.state.lastRevision;
        const event = this.stream.publish("snapshot", "bridge", {records}, {revision});

        return {epoch: event.epoch, watermark: event.sequence, revision, records};
    }

    resetEpoch(): StateSnapshot {
        this.stream.resetEpoch();

        return this.publishSnapshot();
    }

    private publishDelta(record: StateRecord): StateRecord {
        this.stream.publish("delta", record.key, record, {revision: record.revision});

        return record;
    }

    private publishAvailability(record: StateRecord): StateRecord {
        this.stream.publish("availability", record.key, record, {revision: record.revision});

        return record;
    }
}
