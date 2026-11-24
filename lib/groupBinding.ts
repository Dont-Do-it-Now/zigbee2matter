import {type DeviceKey, formatDeviceKey, formatGroupKey, type GroupKey, parseEntityKey} from "./identity";

/** C1 키(DeviceKey/GroupKey 객체 또는 canonical 문자열). 비-key 문자열은 레거시 호출자 호환용이며 통합 시 key로 교체해야 한다. */
export type BindingEntity = DeviceKey | GroupKey | string;

export interface GroupMemberTarget {
    deviceKey: string;
    endpoint: number;
}

export interface GroupCommandPlan {
    groupKey: string;
    collisionKeys: string[];
    members: GroupMemberTarget[];
}

export interface BindingRecord {
    sourceKey: string;
    targetKey: string;
    cluster: string;
    active: boolean;
    updatedAt: number;
}

/** T028 planning layer. Zigbee group semantics stay distinct from Matter groups. */
export function planGroupCommand(groupKey: string, members: ReadonlyArray<GroupMemberTarget>): GroupCommandPlan {
    if (groupKey.length === 0) {
        throw new Error("group key is required");
    }

    const uniqueMembers = new Map<string, GroupMemberTarget>();
    for (const member of members) {
        if (member.deviceKey.length === 0 || !Number.isInteger(member.endpoint) || member.endpoint < 0 || member.endpoint > 255) {
            throw new Error("invalid group member target");
        }

        uniqueMembers.set(`${member.deviceKey}:${member.endpoint}`, {...member});
    }

    return {
        groupKey,
        members: [...uniqueMembers.values()],
        collisionKeys: [groupKey, ...new Set([...uniqueMembers.values()].map((member) => member.deviceKey))],
    };
}

function entityId(entity: BindingEntity): string {
    if (typeof entity === "string") {
        const parsed = parseEntityKey(entity);
        if (!parsed) return entity;

        return parsed.kind === "device" ? formatDeviceKey(parsed) : formatGroupKey(parsed);
    }

    return "ieee" in entity ? formatDeviceKey(entity) : formatGroupKey(entity);
}

/** Tracks direct Zigbee bindings without treating them as Matter group membership. */
export default class BindingRegistry {
    private readonly bindings = new Map<string, BindingRecord>();

    upsert(source: BindingEntity, target: BindingEntity, cluster: string, active: boolean, updatedAt = Date.now()): BindingRecord {
        const sourceKey = entityId(source);
        const targetKey = entityId(target);
        if (!sourceKey || !targetKey || !cluster) {
            throw new Error("binding source, target and cluster are required");
        }

        const record = {sourceKey, targetKey, cluster, active, updatedAt};
        this.bindings.set(bindingId(record), record);

        return {...record};
    }

    remove(sourceKey: BindingEntity, targetKey: BindingEntity, cluster: string, updatedAt = Date.now()): BindingRecord {
        return this.upsert(sourceKey, targetKey, cluster, false, updatedAt);
    }

    list(activeOnly = false): BindingRecord[] {
        return [...this.bindings.values()].filter((record) => !activeOnly || record.active).map((record) => ({...record}));
    }

    has(source: BindingEntity, target: BindingEntity, cluster: string): boolean {
        return (
            this.bindings.get(
                bindingId({sourceKey: entityId(source), targetKey: entityId(target), cluster, active: true, updatedAt: 0}),
            )?.active === true
        );
    }
}

function bindingId(record: Pick<BindingRecord, "sourceKey" | "targetKey" | "cluster">): string {
    return `${record.sourceKey}\u0000${record.targetKey}\u0000${record.cluster}`;
}
