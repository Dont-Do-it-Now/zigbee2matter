/** T061 파일 기반 네트워크 식별자 저장소. Matter fabric/키 저장소와 분리한다. */
import {randomUUID} from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import data from "../util/data";
import type {NetworkIdentity, NetworkIdentityStore} from "./adapter";
import {type BridgeId, generateBridgeId, generateNetworkId, parseBridgeId, parseNetworkId} from "./keys";

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

    /** T019: 최초 기동 시 live extended PAN ID를 기록한다. 이미 기록된 값은 덮어쓰지 않는다(교체는 명시적 절차). */
    recordExtendedPanId(identity: NetworkIdentity, extendedPanId: string): NetworkIdentity {
        if (identity.extendedPanId !== undefined) return identity;

        const next: NetworkIdentity = {networkId: identity.networkId, extendedPanId};
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;
        try {
            writeFileSync(
                temporary,
                `${JSON.stringify(next)}
`,
                {encoding: "utf8", mode: 0o600},
            );
            renameSync(temporary, this.filePath);
        } catch (error) {
            try {
                unlinkSync(temporary);
            } catch {
                // Preserve the original write error.
            }
            throw error;
        }

        return next;
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

        try {
            const descriptor = openSync(temporary, "wx", 0o600);
            try {
                writeFileSync(descriptor, `${JSON.stringify({networkId: identity.networkId})}\n`, "utf8");
                fsyncSync(descriptor);
            } finally {
                closeSync(descriptor);
            }
            linkSync(temporary, this.filePath);
            chmodSync(this.filePath, 0o600);
            syncDirectory(path.dirname(this.filePath));
            unlinkSync(temporary);
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

/** 단일 브리지의 UUID를 별도 파일에 보존한다. 네트워크 UUID와 같은 값으로 대체하지 않는다. */
export class FileBridgeIdentityStore {
    private readonly filePath: string;

    constructor(options: FileNetworkIdentityStoreOptions = {}) {
        this.filePath = options.filePath ?? data.joinPath("bridge-identity.json");
    }

    getOrCreate(): BridgeId {
        if (existsSync(this.filePath)) return this.read();

        const bridgeId = generateBridgeId();

        try {
            this.write(bridgeId);
            return bridgeId;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            return this.read();
        }
    }

    private read(): BridgeId {
        const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
        if (!isRecord(parsed) || typeof parsed.bridgeId !== "string") throw new Error("bridge identity: invalid document");

        const bridgeId = parseBridgeId(parsed.bridgeId);
        if (bridgeId === undefined) throw new Error("bridge identity: invalid bridgeId");
        return bridgeId;
    }

    private write(bridgeId: BridgeId): void {
        const directory = path.dirname(this.filePath);
        mkdirSync(directory, {recursive: true, mode: 0o700});
        chmodSync(directory, 0o700);
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;

        try {
            const descriptor = openSync(temporary, "wx", 0o600);
            try {
                writeFileSync(descriptor, `${JSON.stringify({bridgeId})}\n`, "utf8");
                fsyncSync(descriptor);
            } finally {
                closeSync(descriptor);
            }
            linkSync(temporary, this.filePath);
            chmodSync(this.filePath, 0o600);
            syncDirectory(path.dirname(this.filePath));
            unlinkSync(temporary);
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
