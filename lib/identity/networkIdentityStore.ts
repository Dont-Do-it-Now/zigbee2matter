/** T061 파일 기반 네트워크 식별자 저장소. Matter fabric/키 저장소와 분리한다. */
import {randomUUID} from "node:crypto";
import {chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import path from "node:path";
import data from "../util/data";
import type {NetworkIdentity, NetworkIdentityStore} from "./adapter";
import {generateNetworkId, parseNetworkId} from "./keys";

const DEFAULT_FILE = data.joinPath("network-identity.json");

export interface FileNetworkIdentityStoreOptions {
    filePath?: string;
}

export class FileNetworkIdentityStore implements NetworkIdentityStore {
    private readonly filePath: string;

    constructor(options: FileNetworkIdentityStoreOptions = {}) {
        this.filePath = options.filePath ?? DEFAULT_FILE;
    }

    getOrCreate(): NetworkIdentity {
        if (existsSync(this.filePath)) return this.read();

        const identity: NetworkIdentity = {networkId: generateNetworkId()};

        try {
            this.write(identity);
            return identity;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            return this.read();
        }
    }

    private read(): NetworkIdentity {
        const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
        if (!isRecord(parsed) || typeof parsed.networkId !== "string") throw new Error("network identity: invalid document");

        const networkId = parseNetworkId(parsed.networkId);
        if (networkId === undefined) throw new Error("network identity: invalid networkId");
        const extendedPanId = parsed.extendedPanId;
        if (extendedPanId !== undefined && typeof extendedPanId !== "string") throw new Error("network identity: invalid extendedPanId");

        return {networkId, ...(extendedPanId !== undefined ? {extendedPanId} : {})};
    }

    private write(identity: NetworkIdentity): void {
        const directory = path.dirname(this.filePath);
        mkdirSync(directory, {recursive: true, mode: 0o700});
        chmodSync(directory, 0o700);
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;
        const descriptor = openSync(temporary, "wx", 0o600);

        try {
            writeFileSync(descriptor, `${JSON.stringify({networkId: identity.networkId})}\n`, "utf8");
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }

        try {
            renameSync(temporary, this.filePath);
            chmodSync(this.filePath, 0o600);
        } catch (error) {
            try {
                unlinkSync(temporary);
            } catch {
                // Preserve the original creation error.
            }
            throw error;
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
