import {chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import type {TokenRecord} from "./auth";

/** File-backed API token hashes. Token secrets are never written by this store. */
export class FileApiTokenStore {
    constructor(private readonly filePath: string) {}

    load(): TokenRecord[] {
        if (!existsSync(this.filePath)) return [];

        try {
            const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
            return Array.isArray(parsed) ? (parsed as TokenRecord[]) : [];
        } catch {
            return [];
        }
    }

    save(records: readonly TokenRecord[]): void {
        const directory = path.dirname(this.filePath);
        mkdirSync(directory, {recursive: true, mode: 0o700});
        chmodSync(directory, 0o700);
        const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
        const descriptor = openSync(temporaryPath, "wx", 0o600);

        try {
            writeFileSync(descriptor, JSON.stringify(records), "utf8");
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }

        try {
            renameSync(temporaryPath, this.filePath);
            chmodSync(this.filePath, 0o600);
        } catch (error) {
            try {
                unlinkSync(temporaryPath);
            } catch {
                // Preserve the original persistence error.
            }
            throw error;
        }
    }
}
