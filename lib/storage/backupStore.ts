/** 암호화 백업의 파일 저장 경계(T061/T062). SDK fabric/key store는 읽지 않는다. */
import {randomUUID} from "node:crypto";
import {chmod, mkdir, open, readFile, rename, rm, stat, utimes} from "node:fs/promises";
import path from "node:path";
import data from "../util/data";
import {
    BackupCoordinator,
    createBackup,
    createSnapshotBackup,
    restoreBackup,
    restoreSnapshotBackup,
    type PersistentSnapshot,
} from "./backup";

const BACKUP_DIRECTORY = "backups";
const DEFAULT_FILE_NAME = "latest.backup";
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;

export interface BackupFileStoreOptions {
    directory?: string;
    fileName?: string;
    lockTimeoutMs?: number;
}

export class BackupFileStore {
    private readonly directory: string;
    private readonly fileName: string;
    private readonly lockTimeoutMs: number;
    private readonly coordinator = new BackupCoordinator();

    constructor(options: BackupFileStoreOptions = {}) {
        this.directory = options.directory ?? data.joinPath(BACKUP_DIRECTORY);
        this.fileName = validateFileName(options.fileName ?? DEFAULT_FILE_NAME);
        this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) throw new Error("backup: invalid lock timeout");
    }

    get filePath(): string {
        return path.join(this.directory, this.fileName);
    }

    async write(payload: unknown, passphrase: string): Promise<void> {
        await this.writeEncoded(createBackup(payload, passphrase));
    }

    async read<T>(passphrase: string): Promise<T> {
        return await this.coordinator.run(async () => {
            const release = await acquireLock(`${this.filePath}.lock`, this.lockTimeoutMs);
            try {
                return restoreBackup<T>(await readFile(this.filePath, "utf8"), passphrase);
            } finally {
                await release();
            }
        });
    }

    async writeSnapshot(snapshot: PersistentSnapshot, passphrase: string): Promise<void> {
        await this.writeEncoded(createSnapshotBackup(snapshot, passphrase));
    }

    async readSnapshot(passphrase: string): Promise<PersistentSnapshot> {
        return await this.readSnapshotWith(passphrase, (snapshot) => snapshot);
    }

    async readSnapshotWith<T>(passphrase: string, operation: (snapshot: PersistentSnapshot) => Promise<T> | T): Promise<T> {
        return await this.coordinator.run(async () => {
            const release = await acquireLock(`${this.filePath}.lock`, this.lockTimeoutMs);
            try {
                const snapshot = restoreSnapshotBackup(await readFile(this.filePath, "utf8"), passphrase);
                return await operation(snapshot);
            } finally {
                await release();
            }
        });
    }

    private async writeEncoded(encoded: string): Promise<void> {
        await this.coordinator.run(async () => {
            const release = await acquireLock(`${this.filePath}.lock`, this.lockTimeoutMs);

            try {
                await mkdir(this.directory, {recursive: true, mode: 0o700});
                await chmod(this.directory, 0o700);
                const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

                try {
                    const handle = await open(temporary, "wx", 0o600);
                    try {
                        await handle.writeFile(`${encoded}\n`, "utf8");
                        await handle.sync();
                    } finally {
                        await handle.close();
                    }
                    await chmod(temporary, 0o600);
                    await rename(temporary, this.filePath);
                    await syncDirectory(this.directory);
                } finally {
                    await rm(temporary, {force: true});
                }
            } finally {
                await release();
            }
        });
    }
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + timeoutMs)) throw new Error("backup: invalid lock deadline");
    const deadline = now + timeoutMs;
    const directory = path.dirname(lockPath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);

    while (true) {
        let created = false;
        try {
            const token = randomUUID();
            const handle = await open(lockPath, "wx", 0o600);
            created = true;
            try {
                await handle.writeFile(token, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
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
                    if ((await readFile(lockPath, "utf8")) === token) await rm(lockPath, {force: true});
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            };
        } catch (error) {
            if (created) {
                try {
                    await rm(lockPath, {force: true});
                } catch {
                    // Preserve the original lock creation error.
                }
            }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

            try {
                if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) {
                    await rm(lockPath, {force: true});
                    continue;
                }
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
            }

            if (Date.now() >= deadline) throw new Error("backup: lock timeout");
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
        // Lock refresh failure is handled by the owning operation.
    }
}

function validateFileName(value: string): string {
    if (!value || value === "." || value === ".." || path.basename(value) !== value) {
        throw new Error("backup file name must be a single file name");
    }

    return value;
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

        if (!unsupported) throw error;
    }
}
