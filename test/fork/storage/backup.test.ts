import {describe, expect, it} from "vitest";

import {createBackup, MIN_PASSPHRASE_LENGTH, restoreBackup, validatePassphrase} from "../../../lib/storage/backup";

const PASSPHRASE = "twelve-chars"; // exactly 12 characters

describe("backup passphrase policy", () => {
    it("requires at least 12 characters: 11 is rejected, 12 is accepted", () => {
        expect(MIN_PASSPHRASE_LENGTH).toBe(12);
        expect(PASSPHRASE).toHaveLength(12);
        expect(() => createBackup({a: 1}, "x".repeat(11))).toThrow("at least 12 characters");
        expect(() => createBackup({a: 1}, "x".repeat(12))).not.toThrow();
        expect(() => validatePassphrase("")).toThrow();
        expect(() => validatePassphrase(undefined)).toThrow();
        expect(() => validatePassphrase(123456789012)).toThrow();
    });

    it("round-trips with the right passphrase and never stores plaintext or the passphrase", () => {
        const encoded = createBackup({network_key: [1, 2, 3], name: "secret-name"}, PASSPHRASE);

        expect(encoded).not.toContain("secret-name");
        expect(encoded).not.toContain(PASSPHRASE);
        expect(restoreBackup(encoded, PASSPHRASE)).toEqual({network_key: [1, 2, 3], name: "secret-name"});
    });

    it("rejects a wrong passphrase and a tampered envelope without leaking details", () => {
        const encoded = createBackup({a: 1}, PASSPHRASE);

        expect(() => restoreBackup(encoded, "another-phrase")).toThrow("backup decryption or validation failed");
        const envelope = JSON.parse(encoded) as Record<string, string>;
        envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
        expect(() => restoreBackup(JSON.stringify(envelope), PASSPHRASE)).toThrow("backup decryption or validation failed");
        expect(() => restoreBackup("not json", PASSPHRASE)).toThrow("invalid backup envelope");
    });

    it("uses a fresh salt/iv per backup", () => {
        const a = JSON.parse(createBackup({a: 1}, PASSPHRASE)) as Record<string, string>;
        const b = JSON.parse(createBackup({a: 1}, PASSPHRASE)) as Record<string, string>;

        expect(a.salt).not.toBe(b.salt);
        expect(a.iv).not.toBe(b.iv);
    });
});
