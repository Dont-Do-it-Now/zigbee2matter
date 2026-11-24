/** T064/T065의 staged copy와 원자 승격 실행 경계. */
import {createHash, randomUUID} from "node:crypto";
import {copyFile, lstat, mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import type {ImportConfigurationAction, ImportDataPlan} from "./importData";

export interface StagedImportOptions {
    readonly sourceDataDir: string;
    readonly targetDataDir: string;
    readonly serializeConfiguration?: (configuration: Readonly<Record<string, unknown>>) => string;
    readonly backupSuffix?: string;
}

export interface StagedImportResult {
    readonly promoted: true;
    readonly stagingDir: string;
    readonly backupDir?: string;
}

export async function executeStagedImport(plan: ImportDataPlan, options: StagedImportOptions): Promise<StagedImportResult> {
    if (!plan.canProceed) throw new Error("import plan contains blocking issues");
    const sourceRoot = resolve(options.sourceDataDir);
    const targetRoot = resolve(options.targetDataDir);
    if (sourceRoot === targetRoot) throw new Error("source and target data directories must differ");
    const stagingDir = `${targetRoot}.staging-${randomUUID()}`;
    await mkdir(stagingDir, {recursive: true});
    try {
        for (const action of plan.copyActions) {
            const path = safeRelativeCopyPath(sourceRoot, action.sourcePath, targetRoot, action.targetPath);
            await copyVerified(action.sourcePath, join(stagingDir, path), action.sourceSha256);
        }
        if (plan.configuration) await writeConfiguration(plan.configuration, stagingDir, targetRoot, options.serializeConfiguration);
        const backupDir = await promote(stagingDir, targetRoot, options.backupSuffix ?? `.backup-${Date.now()}`);
        return {promoted: true, stagingDir, backupDir};
    } catch (error) {
        await rm(stagingDir, {recursive: true, force: true});
        throw error;
    }
}

/** operations.ts의 runMigrationOperations에 주입할 실행기를 만든다(2차 통합용 진입점). */
export function createStagedImportExecutor(options: StagedImportOptions): (plan: ImportDataPlan) => Promise<StagedImportResult> {
    return (plan) => executeStagedImport(plan, options);
}

async function copyVerified(sourcePath: string, stagedPath: string, expectedSha256: string): Promise<void> {
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`source is not a regular file: ${sourcePath}`);
    if ((await sha256(sourcePath)).toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`source checksum mismatch: ${sourcePath}`);
    await mkdir(dirname(stagedPath), {recursive: true});
    await copyFile(sourcePath, stagedPath);
    if ((await sha256(sourcePath)).toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`source changed during copy: ${sourcePath}`);
    if ((await sha256(stagedPath)).toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`staged checksum mismatch: ${stagedPath}`);
}

async function writeConfiguration(
    action: ImportConfigurationAction,
    stagingDir: string,
    targetRoot: string,
    serializeConfiguration: StagedImportOptions["serializeConfiguration"],
): Promise<void> {
    if (!serializeConfiguration) throw new Error("configuration serializer is required for staged import");
    const targetRelative = safeRelativeTarget(targetRoot, action.targetPath);
    if ((await sha256(action.sourcePath)).toLowerCase() !== action.sourceSha256.toLowerCase()) {
        throw new Error(`configuration source checksum mismatch: ${action.sourcePath}`);
    }
    const path = join(stagingDir, targetRelative);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, serializeConfiguration(action.configuration), "utf8");
}

async function promote(stagingDir: string, targetRoot: string, suffix: string): Promise<string | undefined> {
    const targetExists = await lstat(targetRoot).then(() => true, () => false);
    const backupDir = targetExists ? `${targetRoot}${suffix}` : undefined;
    if (backupDir) await rename(targetRoot, backupDir);
    try {
        await rename(stagingDir, targetRoot);
        return backupDir;
    } catch (error) {
        if (backupDir) await rename(backupDir, targetRoot).catch(() => undefined);
        throw error;
    }
}

async function sha256(path: string): Promise<string> {
    return createHash("sha256").update(await readFile(path)).digest("hex");
}

function safeRelativeCopyPath(sourceRoot: string, sourcePath: string, targetRoot: string, targetPath: string): string {
    const sourceRelative = safeRelativeTarget(sourceRoot, sourcePath);
    const targetRelative = safeRelativeTarget(targetRoot, targetPath);
    if (sourceRelative !== targetRelative) throw new Error(`source/target relative path mismatch: ${sourceRelative} != ${targetRelative}`);
    return sourceRelative;
}

function safeRelativeTarget(root: string, path: string): string {
    const value = relative(resolve(root), resolve(path));
    if (!value || value.startsWith("..") || isAbsolute(value) || value.split(/[\\/]/).includes("."))
        throw new Error(`path escapes data root: ${path}`);
    return value;
}
