import type {EventStream} from "../events";
import StateReconciler, {type StateRecord} from "./reconciliation";

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

    snapshot(): StateSnapshot {
        const records = this.state.list();
        const event = this.stream.publish("snapshot", "bridge", {records}, {revision: this.state.lastRevision});

        return {epoch: event.epoch, watermark: event.sequence, revision: this.state.lastRevision, records};
    }

    resetEpoch(): StateSnapshot {
        this.stream.resetEpoch();

        return this.snapshot();
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
