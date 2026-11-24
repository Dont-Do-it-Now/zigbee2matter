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
            availability: existing?.availability === "removed" ? "available" : (existing?.availability ?? "available"),
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

        record.availability = availability;

        return {...record};
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
