/** HA Direct/Matter 공용 엔티티 identity registry 경계 (T052). */
import {formatDeviceKey, formatGroupKey, type EntityKey} from "../identity";

export type HaEntityPlatform = "sensor" | "binary_sensor" | "switch" | "cover" | "lock" | "climate" | "button";
export type HaEntityAvailability = "available" | "unavailable" | "removed";

export interface HaEntityRecord {
    uniqueId: string;
    key: string;
    platform: HaEntityPlatform;
    name: string;
    availability: HaEntityAvailability;
    state?: HaEntityState;
}

export interface HaEntityState {
    value: unknown;
    revision: number;
    observedAt: number;
}

export function stableHaUniqueId(key: EntityKey): string {
    return `zigbee2matter:${entityKey(key)}`;
}

export class HaEntityRegistry {
    private readonly records = new Map<string, HaEntityRecord>();

    upsert(key: EntityKey, platform: HaEntityPlatform, name: string): HaEntityRecord {
        const canonicalKey = entityKey(key);
        const uniqueId = `zigbee2matter:${canonicalKey}`;
        const existing = this.records.get(uniqueId);

        if (existing !== undefined && existing.platform !== platform) {
            throw new Error(`HA entity platform changed for ${uniqueId}`);
        }

        const record: HaEntityRecord = {
            uniqueId,
            key: canonicalKey,
            platform,
            name,
            availability: existing?.availability ?? "available",
            state: existing?.state === undefined ? undefined : {...existing.state},
        };
        this.records.set(uniqueId, record);

        return {...record};
    }

    rename(key: EntityKey, name: string): HaEntityRecord | undefined {
        const record = this.records.get(stableHaUniqueId(key));
        if (record === undefined) return undefined;

        record.name = name;

        return {...record};
    }

    setAvailability(key: EntityKey, availability: Exclude<HaEntityAvailability, "removed">): HaEntityRecord | undefined {
        const record = this.records.get(stableHaUniqueId(key));
        if (record === undefined) return undefined;
        if (record.availability === "removed") return {...record};

        record.availability = availability;

        return {...record};
    }

    setState(key: EntityKey, value: unknown, observedAt = Date.now()): HaEntityRecord | undefined {
        const record = this.records.get(stableHaUniqueId(key));
        if (record === undefined) return undefined;
        if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("observedAt must be a non-negative safe integer");

        const revision = record.state?.revision ?? 0;
        if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("HA entity revision exhausted");

        record.state = {
            value,
            revision: revision + 1,
            observedAt,
        };

        return {...record, state: {...record.state}};
    }

    remove(key: EntityKey): HaEntityRecord | undefined {
        const record = this.records.get(stableHaUniqueId(key));
        if (record === undefined) return undefined;

        record.availability = "removed";

        return {...record};
    }

    get(key: EntityKey): HaEntityRecord | undefined {
        const record = this.records.get(stableHaUniqueId(key));

        return record === undefined ? undefined : {...record};
    }

    list(): HaEntityRecord[] {
        return [...this.records.values()].map((record) => ({...record}));
    }
}

function entityKey(key: EntityKey): string {
    return key.kind === "device" ? formatDeviceKey(key) : formatGroupKey(key);
}
