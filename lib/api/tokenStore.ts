import {randomUUID} from "node:crypto";
import {chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import path from "node:path";
import type {TokenRecord} from "./auth";

/** File-backed API token hashes. Token secrets are never written by this store. */
export class FileApiTokenStore {
    constructor(
        private readonly filePath: string,
        private readonly warn?: (message: string) => void,
    ) {}

    load(): TokenRecord[] {
        if (!existsSync(this.filePath)) return [];

        try {
            const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
            if (Array.isArray(parsed)) return parsed as TokenRecord[];
        } catch {
            // 아래에서 손상 파일로 처리한다.
        }
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
            renameSync(this.filePath, corruptPath);
            this.warn?.(`API token store is corrupt; preserved as ${corruptPath} and starting empty`);
        } catch {
            this.warn?.("API token store is corrupt and could not be preserved; starting empty");
        }
        return [];
    }

    save(records: readonly TokenRecord[]): void {
        const directory = path.dirname(this.filePath);
        mkdirSync(directory, {recursive: true, mode: 0o700});
        chmodSync(directory, 0o700);
        const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;

        try {
            const descriptor = openSync(temporaryPath, "wx", 0o600);
            try {
                writeFileSync(descriptor, JSON.stringify(records), "utf8");
                fsyncSync(descriptor);
            } finally {
                closeSync(descriptor);
            }
            renameSync(temporaryPath, this.filePath);
            chmodSync(this.filePath, 0o600);
            syncDirectory(directory);
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

function syncDirectory(directory: string): void {
    try {
        const descriptor = openSync(directory, "r");
        try {
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const unsupported = code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" || (process.platform === "win32" && code === "EPERM");
        if (!unsupported) throw error;
    }
}
