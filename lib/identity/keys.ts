/**
 * Entity identity keys (T019, CONTRACTS C1). Pure functions/types, no Matter/HTTP/Core imports (C5).
 *
 * - DeviceKey = network UUID + IEEE (16 hex, lowercase, no prefix) + Zigbee endpoint ID + feature path.
 * - GroupKey  = network UUID + groupID + feature path (separate namespace from devices).
 * - BridgeKey = its own UUID (independent from the network UUID).
 * Friendly name and NWK address are display-only and never part of a key.
 *
 * String form (stable, parseable; `:` separates fixed fields, feature path is the last field):
 *   dev:<networkId>:<ieee16>:<endpoint>:<feature/path>
 *   grp:<networkId>:<groupId>:<feature/path>
 *   bridge:<bridgeId>
 */

import {randomUUID} from "node:crypto";

export type NetworkId = string & {readonly __brand: "NetworkId"};
export type BridgeId = string & {readonly __brand: "BridgeId"};
/** 16 lowercase hex chars, no `0x` prefix. */
export type Ieee16 = string & {readonly __brand: "Ieee16"};

export interface DeviceKey {
    networkId: NetworkId;
    ieee: Ieee16;
    /** Zigbee endpoint ID (`zh.Endpoint.ID`), not the Z2M endpoint label (`l1`, ...). */
    endpoint: number;
    /** Slash separated segments of `[A-Za-z0-9_]`, e.g. `onoff/state`. */
    feature: string;
}

export interface GroupKey {
    networkId: NetworkId;
    groupId: number;
    feature: string;
}

export type EntityKey = ({kind: "device"} & DeviceKey) | ({kind: "group"} & GroupKey);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IEEE_RE = /^(?:0x)?([0-9a-f]{16})$/;
const FEATURE_RE = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/;
const CANONICAL_INT_RE = /^(?:0|[1-9][0-9]*)$/;
const MAX_ENDPOINT = 255;
const MAX_GROUP_ID = 0xffff;

function normalizeUuid(value: string): string | undefined {
    const v = value.trim().toLowerCase();

    return UUID_RE.test(v) ? v : undefined;
}

/** Normalizes `0x00124B...` / `00124b...` (any case) to 16 lowercase hex. Undefined if invalid (length != 16, non-hex, all zero). */
export function normalizeIeee(value: string): Ieee16 | undefined {
    const match = IEEE_RE.exec(value.trim().toLowerCase());
    const hex = match?.[1];

    return hex !== undefined && /[1-9a-f]/.test(hex) ? (hex as Ieee16) : undefined;
}

/** Herdsman/Z2M form (`0x` + lowercase 16 hex), e.g. for `Zigbee.resolveEntity`. */
export function toHerdsmanIeee(ieee: Ieee16): string {
    return `0x${ieee}`;
}

export function parseNetworkId(value: string): NetworkId | undefined {
    return normalizeUuid(value) as NetworkId | undefined;
}

export function parseBridgeId(value: string): BridgeId | undefined {
    return normalizeUuid(value) as BridgeId | undefined;
}

export function generateNetworkId(): NetworkId {
    return randomUUID() as NetworkId;
}

export function generateBridgeId(): BridgeId {
    return randomUUID() as BridgeId;
}

export function isValidFeaturePath(feature: string): boolean {
    return FEATURE_RE.test(feature);
}

/** Builds a DeviceKey from raw inputs; `ieee` accepts any form of `normalizeIeee`. Undefined on any invalid field. */
export function makeDeviceKey(networkId: string, ieee: string, endpoint: number, feature: string): DeviceKey | undefined {
    const nid = parseNetworkId(networkId);
    const ieee16 = normalizeIeee(ieee);

    if (!nid || !ieee16 || !Number.isInteger(endpoint) || endpoint < 0 || endpoint > MAX_ENDPOINT || !isValidFeaturePath(feature)) {
        return undefined;
    }

    return {networkId: nid, ieee: ieee16, endpoint, feature};
}

export function makeGroupKey(networkId: string, groupId: number, feature: string): GroupKey | undefined {
    const nid = parseNetworkId(networkId);

    if (!nid || !Number.isInteger(groupId) || groupId < 0 || groupId > MAX_GROUP_ID || !isValidFeaturePath(feature)) {
        return undefined;
    }

    return {networkId: nid, groupId, feature};
}

export function formatDeviceKey(key: DeviceKey): string {
    return `dev:${key.networkId}:${key.ieee}:${key.endpoint}:${key.feature}`;
}

export function formatGroupKey(key: GroupKey): string {
    return `grp:${key.networkId}:${key.groupId}:${key.feature}`;
}

export function formatBridgeKey(id: BridgeId): string {
    return `bridge:${id}`;
}

/** Strict parse of the canonical string form (round-trips exactly; decimal numbers without leading zeros). */
export function parseEntityKey(value: string): EntityKey | undefined {
    const parts = value.split(":");

    if (parts[0] === "dev" && parts.length === 5 && CANONICAL_INT_RE.test(parts[3])) {
        const key = makeDeviceKey(parts[1], parts[2], Number(parts[3]), parts[4]);

        return key && formatDeviceKey(key) === value ? {kind: "device", ...key} : undefined;
    }

    if (parts[0] === "grp" && parts.length === 4 && CANONICAL_INT_RE.test(parts[2])) {
        const key = makeGroupKey(parts[1], Number(parts[2]), parts[3]);

        return key && formatGroupKey(key) === value ? {kind: "group", ...key} : undefined;
    }

    return undefined;
}

export function parseBridgeKey(value: string): BridgeId | undefined {
    return value.startsWith("bridge:") ? parseBridgeId(value.slice("bridge:".length)) : undefined;
}

export function deviceKeyEquals(a: DeviceKey, b: DeviceKey): boolean {
    return a.networkId === b.networkId && a.ieee === b.ieee && a.endpoint === b.endpoint && a.feature === b.feature;
}

export function groupKeyEquals(a: GroupKey, b: GroupKey): boolean {
    return a.networkId === b.networkId && a.groupId === b.groupId && a.feature === b.feature;
}
