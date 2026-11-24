/**
 * T061 파일 기반 EndpointRegistryStore.
 *
 * 자체 endpoint 매핑만 저장한다. Matter SDK의 fabric/key 저장소는 이 어댑터의 소유 범위가 아니다.
 * 쓰기는 임시 파일 -> rename 순서이며, 프로세스 간 동시 쓰기는 lock 파일로 직렬화한다.
 */
import {randomUUID} from "node:crypto";
import {chmod, mkdir, open, readFile, rename, rm, stat, utimes} from "node:fs/promises";
import path from "node:path";

import {parseBridgeId, type BridgeId} from "../identity";
import data from "../util/data";
import {
    type EndpointRegistryDocument,
    type EndpointRegistryStore,
    parseEndpointRegistryDocument,
} from "./endpointRegistry";

const REGISTRY_DIRECTORY = path.join("matter", "endpoint-registry");
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;

export interface FileEndpointRegistryStoreOptions {
    directory?: string;
    lockTimeoutMs?: number;
}

export class FileEndpointRegistryStore implements EndpointRegistryStore {
    private readonly directory: string;
    private readonly lockTimeoutMs: number;

    constructor(options: FileEndpointRegistryStoreOptions = {}) {
        this.directory = options.directory ?? data.joinPath(REGISTRY_DIRECTORY);
        this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    }

    async load(bridgeId: BridgeId): Promise<EndpointRegistryDocument | undefined> {
        const file = this.filePath(bridgeId);

        try {
            const raw = await readFile(file, "utf8");

            return parseEndpointRegistryDocument(JSON.parse(raw), bridgeId);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }

            throw error;
        }
    }

    async save(bridgeId: BridgeId, document: EndpointRegistryDocument): Promise<void> {
        const validated = parseEndpointRegistryDocument(document, bridgeId);
        const file = this.filePath(bridgeId);
        const lock = `${file}.lock`;
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        const release = await acquireLock(lock, this.lockTimeoutMs);

        try {
            await mkdir(this.directory, {recursive: true, mode: 0o700});
            await chmod(this.directory, 0o700);
            const handle = await open(temporary, "wx", 0o600);

            try {
                await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }

            await chmod(temporary, 0o600);
            await rename(temporary, file);
            await syncDirectory(this.directory);
        } finally {
            await rm(temporary, {force: true});
            await release();
        }
    }

    private filePath(bridgeId: BridgeId): string {
        const normalized = parseBridgeId(bridgeId);

        if (normalized === undefined) {
            throw new Error("endpoint registry: invalid bridgeId");
        }

        return path.join(this.directory, `${normalized}.json`);
    }
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
    const deadline = Date.now() + timeoutMs;
    const directory = path.dirname(lockPath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);

    while (true) {
        try {
            const token = randomUUID();
            const handle = await open(lockPath, "wx", 0o600);
            await handle.writeFile(token, "utf8");
            await handle.sync();
            await handle.close();
            const heartbeat = setInterval(() => {
                void refreshLock(lockPath, token);
            }, Math.max(1000, Math.floor(LOCK_STALE_MS / 3)));
            heartbeat.unref?.();
            let released = false;

            return async () => {
                if (released) return;

                released = true;
                clearInterval(heartbeat);

                try {
                    if ((await readFile(lockPath, "utf8")) === token) {
                        await rm(lockPath, {force: true});
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            try {
                const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;

                if (lockAge > LOCK_STALE_MS) {
                    await rm(lockPath, {force: true});
                    continue;
                }
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw statError;
                }
            }

            if (Date.now() >= deadline) {
                throw new Error("endpoint registry: lock timeout");
            }

            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
    }
}

async function refreshLock(lockPath: string, token: string): Promise<void> {
    try {
        if ((await readFile(lockPath, "utf8")) === token) {
            const now = new Date();
            await utimes(lockPath, now, now);
        }
    } catch {
        // The owner observes the next save failure; a refresh failure must not become an unhandled rejection.
    }
}

async function syncDirectory(directory: string): Promise<void> {
    try {
        const handle = await open(directory, "r");

        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        const unsupported = code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" || (process.platform === "win32" && code === "EPERM");

        if (!unsupported) {
            throw error;
        }
    }
}
