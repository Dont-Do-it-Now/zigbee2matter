/**
 * Adapters deriving keys from existing Core objects without modifying them (T019).
 * Structural types only (no import of Device/Group classes), so the module stays decoupled and testable with plain objects.
 *
 * Reused upstream identity: `Device.ieeeAddr`/`Device.ID` (= `zh.ieeeAddr`, `0x` + lowercase hex), `zh.Endpoint.ID` (numeric),
 * `Group.ID` (= `zh.groupID`). `Device.name` / `Group.name` / NWK address are NOT used.
 */

import {
    type BridgeId,
    type DeviceKey,
    formatBridgeKey,
    formatDeviceKey,
    formatGroupKey,
    type GroupKey,
    makeDeviceKey,
    makeGroupKey,
    type NetworkId,
} from "./keys";

export interface IdentityDeviceLike {
    ieeeAddr: string;
}

export interface IdentityEndpointLike {
    ID: number;
}

export interface IdentityGroupLike {
    ID: number;
}

/**
 * Network identity (interface only; persistence is T061).
 * Decision: a separate persisted UUID, NOT derived from herdsman values (see `bindingMatches`).
 */
export interface NetworkIdentity {
    networkId: NetworkId;
    /** herdsman `getNetworkParameters().extendedPanID` (`0x` + 16 hex) recorded at creation; diagnostic binding only. */
    extendedPanId?: string;
}

export interface NetworkIdentityStore {
    /** Returns the persisted identity or creates one (`generateNetworkId`) on first start. Implemented by T061. */
    getOrCreate(): NetworkIdentity;
}

export function deviceKeyOf(
    networkId: NetworkId,
    device: IdentityDeviceLike,
    endpoint: IdentityEndpointLike,
    feature: string,
): DeviceKey | undefined {
    return makeDeviceKey(networkId, device.ieeeAddr, endpoint.ID, feature);
}

export function groupKeyOf(networkId: NetworkId, group: IdentityGroupLike, feature: string): GroupKey | undefined {
    return makeGroupKey(networkId, group.ID, feature);
}

export function deviceKeyStringOf(
    networkId: NetworkId,
    device: IdentityDeviceLike,
    endpoint: IdentityEndpointLike,
    feature: string,
): string | undefined {
    const key = deviceKeyOf(networkId, device, endpoint, feature);

    return key ? formatDeviceKey(key) : undefined;
}

export function groupKeyStringOf(networkId: NetworkId, group: IdentityGroupLike, feature: string): string | undefined {
    const key = groupKeyOf(networkId, group, feature);

    return key ? formatGroupKey(key) : undefined;
}

export function bridgeKeyStringOf(bridgeId: BridgeId): string {
    return formatBridgeKey(bridgeId);
}

/**
 * Detects a coordinator/network swap: stored extended PAN ID vs the live one (case-insensitive). An unknown stored value matches.
 * Caller policy (T061/T064): on mismatch, do not reuse keys silently (log + require explicit confirmation).
 */
export function bindingMatches(stored: NetworkIdentity, liveExtendedPanId: string): boolean {
    return stored.extendedPanId === undefined || stored.extendedPanId.toLowerCase() === liveExtendedPanId.toLowerCase();
}
