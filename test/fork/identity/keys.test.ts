import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {
    bindingMatches,
    bridgeKeyStringOf,
    deviceKeyEquals,
    deviceKeyOf,
    deviceKeyStringOf,
    FileBridgeIdentityStore,
    FileNetworkIdentityStore,
    formatBridgeKey,
    formatDeviceKey,
    formatGroupKey,
    generateBridgeId,
    generateNetworkId,
    groupKeyEquals,
    groupKeyOf,
    groupKeyStringOf,
    isValidFeaturePath,
    makeDeviceKey,
    makeGroupKey,
    normalizeIeee,
    parseBridgeId,
    parseBridgeKey,
    parseEntityKey,
    parseNetworkId,
    toHerdsmanIeee,
} from "../../../lib/identity";

const NET = "11111111-1111-4111-8111-111111111111";
const IEEE = "00124b00120144ae";

describe("normalizeIeee", () => {
    it.each([
        ["0x00124B00120144AE", IEEE],
        ["00124b00120144ae", IEEE],
        ["  0x00124b00120144ae  ", IEEE],
    ])("normalizes %s", (input, expected) => {
        expect(normalizeIeee(input)).toBe(expected);
    });

    it.each(["", "0x", "0x1234", "0x00124b00120144a", "0x00124b00120144aef", "0xzz124b00120144ae", "0x0000000000000000", "0000000000000000"])(
        "rejects %j",
        (input) => {
            expect(normalizeIeee(input)).toBeUndefined();
        },
    );

    it("round-trips to the herdsman form", () => {
        expect(toHerdsmanIeee(normalizeIeee("0x00124B00120144AE")!)).toBe("0x00124b00120144ae");
    });
});

describe("network/bridge ids", () => {
    it("parses and lowercases UUIDs, rejects non-UUID input", () => {
        expect(parseNetworkId(NET.toUpperCase())).toBe(NET);
        expect(parseNetworkId(` ${NET} `)).toBe(NET);
        for (const bad of ["", "not-a-uuid", NET.replace(/-/g, ""), `${NET}0`, "11111111-1111-4111-8111-11111111111g"]) {
            expect(parseNetworkId(bad)).toBeUndefined();
            expect(parseBridgeId(bad)).toBeUndefined();
        }
    });

    it("generates valid, distinct ids and keeps network and bridge namespaces separate", () => {
        const a = generateNetworkId();
        const b = generateNetworkId();
        expect(parseNetworkId(a)).toBe(a);
        expect(a).not.toBe(b);
        const bridge = generateBridgeId();
        expect(parseBridgeId(bridge)).toBe(bridge);
        expect(formatBridgeKey(bridge)).toBe(`bridge:${bridge}`);
        expect(parseBridgeKey(`bridge:${bridge}`)).toBe(bridge);
        expect(parseBridgeKey(bridge)).toBeUndefined();
        expect(parseEntityKey(`bridge:${bridge}`)).toBeUndefined();
    });
});

describe("feature paths", () => {
    it.each(["state", "onoff/state", "a_b/C9"])("accepts %s", (feature) => expect(isValidFeaturePath(feature)).toBe(true));
    it.each(["", "/a", "a/", "a//b", "a:b", "a b", "a-b", "../x", "a/../b"])("rejects %j", (feature) =>
        expect(isValidFeaturePath(feature)).toBe(false),
    );
});

describe("makeDeviceKey/makeGroupKey", () => {
    it("builds normalized keys from any ieee spelling", () => {
        expect(makeDeviceKey(NET.toUpperCase(), "0x00124B00120144AE", 1, "state")).toStrictEqual({
            networkId: NET,
            ieee: IEEE,
            endpoint: 1,
            feature: "state",
        });
        expect(makeGroupKey(NET, 7, "state")).toStrictEqual({networkId: NET, groupId: 7, feature: "state"});
    });

    it("rejects invalid fields and endpoint/group range edges", () => {
        expect(makeDeviceKey("bad", IEEE, 1, "state")).toBeUndefined();
        expect(makeDeviceKey(NET, "0x12", 1, "state")).toBeUndefined();
        expect(makeDeviceKey(NET, IEEE, -1, "state")).toBeUndefined();
        expect(makeDeviceKey(NET, IEEE, 256, "state")).toBeUndefined();
        expect(makeDeviceKey(NET, IEEE, 1.5, "state")).toBeUndefined();
        expect(makeDeviceKey(NET, IEEE, Number.NaN, "state")).toBeUndefined();
        expect(makeDeviceKey(NET, IEEE, 1, "bad:feature")).toBeUndefined();
        expect(makeDeviceKey(NET, IEEE, 0, "state")).toBeDefined();
        expect(makeDeviceKey(NET, IEEE, 255, "state")).toBeDefined();
        expect(makeGroupKey(NET, -1, "state")).toBeUndefined();
        expect(makeGroupKey(NET, 0x10000, "state")).toBeUndefined();
        expect(makeGroupKey(NET, 0xffff, "state")).toBeDefined();
        expect(makeGroupKey(NET, 0, "state")).toBeDefined();
    });
});

describe("format/parse round trip", () => {
    it("round-trips device and group keys exactly", () => {
        const dev = formatDeviceKey(makeDeviceKey(NET, IEEE, 12, "onoff/state")!);
        expect(dev).toBe(`dev:${NET}:${IEEE}:12:onoff/state`);
        expect(parseEntityKey(dev)).toStrictEqual({kind: "device", networkId: NET, ieee: IEEE, endpoint: 12, feature: "onoff/state"});

        const grp = formatGroupKey(makeGroupKey(NET, 300, "state")!);
        expect(grp).toBe(`grp:${NET}:300:state`);
        expect(parseEntityKey(grp)).toStrictEqual({kind: "group", networkId: NET, groupId: 300, feature: "state"});
    });

    it("rejects non-canonical strings (uppercase, 0x prefix, leading zeros, wrong arity, injection)", () => {
        const bad = [
            `dev:${NET}:0x${IEEE}:1:state`, // prefix not canonical
            `dev:${NET}:${IEEE.toUpperCase()}:1:state`, // uppercase not canonical
            `dev:${NET.toUpperCase()}:${IEEE}:1:state`,
            `dev:${NET}:${IEEE}:01:state`, // leading zero
            `dev:${NET}:${IEEE}:+1:state`,
            `dev:${NET}:${IEEE}:1e0:state`,
            `dev:${NET}:${IEEE}:1:state:extra`,
            `dev:${NET}:${IEEE}:1`,
            `grp:${NET}:007:state`,
            `grp:${NET}:70000:state`,
            `grp:${NET}:1:a:b`,
            `${"x:"}${NET}:${IEEE}:1:state`,
            "",
            "dev",
        ];

        for (const value of bad) {
            expect(parseEntityKey(value), value).toBeUndefined();
        }
    });
});

describe("equality and adapters", () => {
    it("compares keys structurally, and device and group namespaces never alias", () => {
        const a = makeDeviceKey(NET, IEEE, 1, "state")!;
        expect(deviceKeyEquals(a, makeDeviceKey(NET, `0x${IEEE}`, 1, "state")!)).toBe(true);
        expect(deviceKeyEquals(a, makeDeviceKey(NET, IEEE, 2, "state")!)).toBe(false);
        expect(deviceKeyEquals(a, makeDeviceKey(NET, IEEE, 1, "other")!)).toBe(false);
        const g = makeGroupKey(NET, 1, "state")!;
        expect(groupKeyEquals(g, makeGroupKey(NET, 1, "state")!)).toBe(true);
        expect(groupKeyEquals(g, makeGroupKey(NET, 2, "state")!)).toBe(false);
        expect(formatDeviceKey(a)).not.toBe(formatGroupKey(g));
    });

    it("derives keys from Core-like objects without using names or NWK addresses", () => {
        const network = parseNetworkId(NET)!;
        const device = {ieeeAddr: "0x00124B00120144AE", name: "kitchen", networkAddress: 1234};
        expect(deviceKeyOf(network, device, {ID: 3}, "state")).toStrictEqual({networkId: NET, ieee: IEEE, endpoint: 3, feature: "state"});
        const renamed = {...device, name: "renamed", networkAddress: 9999};
        expect(deviceKeyStringOf(network, renamed, {ID: 3}, "state")).toBe(deviceKeyStringOf(network, device, {ID: 3}, "state"));
        expect(deviceKeyStringOf(network, {ieeeAddr: "bad"}, {ID: 1}, "state")).toBeUndefined();
        expect(groupKeyStringOf(network, {ID: 9}, "state")).toBe(`grp:${NET}:9:state`);
        expect(groupKeyOf(network, {ID: -1}, "state")).toBeUndefined();
        expect(bridgeKeyStringOf(generateBridgeId())).toMatch(/^bridge:/);
    });

    it("detects a coordinator swap by extended PAN id (case-insensitive, unknown stored value matches)", () => {
        const network = parseNetworkId(NET)!;
        expect(bindingMatches({networkId: network}, "0xAA")).toBe(true);
        expect(bindingMatches({networkId: network, extendedPanId: "0xaabb"}, "0xAABB")).toBe(true);
        expect(bindingMatches({networkId: network, extendedPanId: "0xaabb"}, "0xaabc")).toBe(false);
    });
});

describe("file identity stores", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "z2matter-identity-"));
    });
    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it("creates the network id once, persists it and never overwrites the recorded extended PAN id", () => {
        const file = path.join(dir, "nested", "network-identity.json");
        const store = new FileNetworkIdentityStore({filePath: file});
        const first = store.getOrCreate();
        expect(parseNetworkId(first.networkId)).toBe(first.networkId);
        expect(new FileNetworkIdentityStore({filePath: file}).getOrCreate()).toStrictEqual(first);

        const recorded = store.recordExtendedPanId(first, "0xaabbccddeeff0011");
        expect(recorded.extendedPanId).toBe("0xaabbccddeeff0011");
        expect(store.recordExtendedPanId(recorded, "0x1111111111111111")).toBe(recorded);
        expect(new FileNetworkIdentityStore({filePath: file}).getOrCreate()).toStrictEqual(recorded);
        expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toStrictEqual([]);
    });

    it("rejects a corrupt identity document instead of silently regenerating", () => {
        const file = path.join(dir, "network-identity.json");
        fs.writeFileSync(file, JSON.stringify({networkId: "nope"}));
        expect(() => new FileNetworkIdentityStore({filePath: file}).getOrCreate()).toThrow("invalid networkId");
        fs.writeFileSync(file, "[]");
        expect(() => new FileNetworkIdentityStore({filePath: file}).getOrCreate()).toThrow("invalid document");
        fs.writeFileSync(file, JSON.stringify({networkId: NET, extendedPanId: 5}));
        expect(() => new FileNetworkIdentityStore({filePath: file}).getOrCreate()).toThrow("invalid extendedPanId");
    });

    it("keeps the bridge id independent from the network id and stable across instances", () => {
        const networkFile = path.join(dir, "network-identity.json");
        const bridgeFile = path.join(dir, "bridge-identity.json");
        const network = new FileNetworkIdentityStore({filePath: networkFile}).getOrCreate();
        const bridge = new FileBridgeIdentityStore({filePath: bridgeFile}).getOrCreate();

        expect(bridge).not.toBe(network.networkId);
        expect(new FileBridgeIdentityStore({filePath: bridgeFile}).getOrCreate()).toBe(bridge);
        fs.writeFileSync(bridgeFile, JSON.stringify({bridgeId: "bad"}));
        expect(() => new FileBridgeIdentityStore({filePath: bridgeFile}).getOrCreate()).toThrow("invalid bridgeId");
    });
});
