import type {PersistentSnapshot} from "../storage/backup";

export interface BackupSnapshotProvider {
    identity(): unknown | Promise<unknown>;
    fabric(): unknown | Promise<unknown>;
    /** Zigbee 필수 데이터 파일 집합(선택). */
    zigbee?(): unknown | Promise<unknown>;
}

export interface BackupRestoreResult {
    applied: boolean;
    reason?: string;
}

/** Applies a validated snapshot to the owning identity, fabric and endpoint stores. */
export interface BackupSnapshotAdapter {
    restore(snapshot: PersistentSnapshot): Promise<BackupRestoreResult> | BackupRestoreResult;
}

export function assertSnapshotProvider(provider: BackupSnapshotProvider | undefined): asserts provider is BackupSnapshotProvider {
    if (!provider) throw new Error("backup snapshot provider is not configured");
    if (typeof provider.identity !== "function" || typeof provider.fabric !== "function") {
        throw new Error("backup snapshot provider contract is invalid");
    }
}

export function validateSnapshotParts(identity: unknown, fabric: unknown, endpointRegistry: unknown): void {
    if (identity === undefined || fabric === undefined || endpointRegistry === undefined) {
        throw new Error("backup snapshot identity, fabric or endpoint registry is missing");
    }
}

export function assertRestoreApplied(result: BackupRestoreResult): void {
    if (result?.applied !== true) {
        throw new Error(result?.reason ?? "persistent backup was not applied");
    }
}
