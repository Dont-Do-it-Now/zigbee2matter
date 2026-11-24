/** 암호화 백업의 파일 저장 경계(T061/T062). SDK fabric/key store는 읽지 않는다. */
import {randomUUID} from "node:crypto";
import {chmod, mkdir, open, readFile, rename, rm} from "node:fs/promises";
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

export interface BackupFileStoreOptions {
    directory?: string;
    fileName?: string;
}

export class BackupFileStore {
    private readonly directory: string;
    private readonly fileName: string;
    private readonly coordinator = new BackupCoordinator();

    constructor(options: BackupFileStoreOptions = {}) {
        this.directory = options.directory ?? data.joinPath(BACKUP_DIRECTORY);
        this.fileName = validateFileName(options.fileName ?? DEFAULT_FILE_NAME);
    }

    get filePath(): string {
        return path.join(this.directory, this.fileName);
    }

    async write(payload: unknown, passphrase: string): Promise<void> {
        await this.writeEncoded(createBackup(payload, passphrase));
    }

    async read<T>(passphrase: string): Promise<T> {
        return await this.coordinator.run(async () => restoreBackup<T>(await readFile(this.filePath, "utf8"), passphrase));
    }

    async writeSnapshot(snapshot: PersistentSnapshot, passphrase: string): Promise<void> {
        await this.writeEncoded(createSnapshotBackup(snapshot, passphrase));
    }

    async readSnapshot(passphrase: string): Promise<PersistentSnapshot> {
        return await this.coordinator.run(async () => restoreSnapshotBackup(await readFile(this.filePath, "utf8"), passphrase));
    }

    private async writeEncoded(encoded: string): Promise<void> {
        await this.coordinator.run(async () => {
            await mkdir(this.directory, {recursive: true, mode: 0o700});
            await chmod(this.directory, 0o700);
            const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
            const handle = await open(temporary, "wx", 0o600);

            try {
                await handle.writeFile(`${encoded}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }

            try {
                await chmod(temporary, 0o600);
                await rename(temporary, this.filePath);
                await syncDirectory(this.directory);
            } finally {
                await rm(temporary, {force: true});
            }
        });
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
