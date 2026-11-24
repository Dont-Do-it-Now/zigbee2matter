import {isDeepStrictEqual} from "node:util";

export type StateQuality = "confirmed" | "estimated" | "stale" | "unknown";

export interface StateRecord {
    key: string;
    observedValue?: unknown;
    desiredValue?: unknown;
    quality: StateQuality;
    revision: number;
    observedAt?: number;
    availability?: boolean;
}

export interface StateReconcilerOptions {
    now?: () => number;
}

/** C2 single-writer state reconciler. Command results never become observations. */
export default class StateReconciler {
    private readonly records = new Map<string, StateRecord>();
    private readonly now: () => number;
    private revision = 0;

    constructor(options: StateReconcilerOptions = {}) {
        this.now = options.now ?? ((): number => Date.now());
    }

    get lastRevision(): number {
        return this.revision;
    }

    get(key: string): StateRecord | undefined {
        const record = this.records.get(key);

        return record === undefined ? undefined : cloneRecord(record);
    }

    list(): StateRecord[] {
        return [...this.records.values()].map(cloneRecord);
    }

    /** A device report is the only operation that confirms observed state. Late reports are still accepted. */
    observe(key: string, value: unknown, observedAt = this.now()): StateRecord {
        const record = this.getOrCreate(key);
        record.observedValue = cloneValue(value);
        record.observedAt = observedAt;
        record.availability = true;
        record.quality = "confirmed";

        if (record.desiredValue !== undefined && isDeepStrictEqual(record.desiredValue, record.observedValue)) {
            delete record.desiredValue;
        }

        return this.commit(record);
    }

    /** Records intent separately; it never changes observedValue to the desired value. */
    desire(key: string, value: unknown): StateRecord {
        const record = this.getOrCreate(key);
        const desired = cloneValue(value);

        if (record.observedValue !== undefined && isDeepStrictEqual(record.observedValue, desired)) {
            delete record.desiredValue;
            record.quality = record.availability === false ? "stale" : "confirmed";
        } else {
            record.desiredValue = desired;
            record.quality = record.observedValue === undefined ? "unknown" : "estimated";
        }

        return this.commit(record);
    }

    markUnavailable(key: string): StateRecord {
        const record = this.getOrCreate(key);
        record.availability = false;
        record.quality = record.observedValue === undefined ? "unknown" : "stale";

        return this.commit(record);
    }

    markAvailable(key: string): StateRecord {
        const record = this.getOrCreate(key);
        record.availability = true;
        record.quality = record.observedValue === undefined ? "unknown" : "stale";

        return this.commit(record);
    }

    markUnknown(key: string): StateRecord {
        const record = this.getOrCreate(key);
        record.quality = "unknown";

        return this.commit(record);
    }

    remove(key: string): boolean {
        if (!this.records.delete(key)) return false;
        this.revision += 1;

        return true;
    }

    private getOrCreate(key: string): StateRecord {
        if (key.length === 0) {
            throw new Error("state key is required");
        }

        const existing = this.records.get(key);
        if (existing) {
            return {...existing};
        }

        return {key, quality: "unknown", revision: 0};
    }

    private commit(record: StateRecord): StateRecord {
        record.revision = ++this.revision;
        this.records.set(record.key, record);

        return cloneRecord(record);
    }
}

function cloneValue(value: unknown): unknown {
    return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

function cloneRecord(record: StateRecord): StateRecord {
    return {
        ...record,
        ...(record.observedValue === undefined ? {} : {observedValue: cloneValue(record.observedValue)}),
        ...(record.desiredValue === undefined ? {} : {desiredValue: cloneValue(record.desiredValue)}),
    };
}
