/** 디렉터리/파일 단위 snapshot 경계(T061/T062). 파일 내용은 해석하지 않고 바이트 그대로 보존한다. */
import {randomUUID} from "node:crypto";
import {chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";

export interface FileSetEntry {
    /** 루트 기준 상대 경로(`/` 구분). */
    path: string;
    data: string;
    /** 원본 파일 권한(하위 9비트). 구버전 snapshot에는 없으며 복원 시 0600을 쓴다. */
    mode?: number;
}

export interface FileSet {
    format: "zigbee2matter.fileset";
    version: 1;
    files: FileSetEntry[];
}

export function emptyFileSet(): FileSet {
    return {format: "zigbee2matter.fileset", version: 1, files: []};
}

export function isFileSet(value: unknown): value is FileSet {
    if (typeof value !== "object" || value === null) return false;
    const set = value as Partial<FileSet>;

    return set.format === "zigbee2matter.fileset" && set.version === 1 && Array.isArray(set.files);
}

async function walk(root: string, relative: string, out: string[]): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("fileset: symbolic links are not supported");
        if (entry.isDirectory()) await walk(root, rel, out);
        else if (entry.isFile()) out.push(rel);
    }
}

/** 디렉터리 전체의 (경로, 크기, mtime) 서명. 스냅샷 전후 비교로 쓰기 중 변경을 감지한다. */
async function signature(root: string, files: readonly string[]): Promise<string> {
    const parts: string[] = [];
    for (const file of files) {
        const info = await lstat(path.join(root, file));
        parts.push(`${file}:${info.size}:${info.mtimeMs}`);
    }

    return parts.join("|");
}

/**
 * 디렉터리를 파일 단위로 읽는다. 읽는 동안 파일 집합/크기/mtime이 바뀌면(SDK가 쓰는 중) 재시도하고, 끝내 안정되지 않으면 실패한다.
 * 디렉터리가 없으면 빈 집합이다.
 */
export async function readDirectoryFileSet(root: string, attempts = 5): Promise<FileSet> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const files: string[] = [];
        try {
            await walk(root, "", files);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFileSet();
            throw error;
        }
        files.sort();
        try {
            const before = await signature(root, files);
            const entries: FileSetEntry[] = [];
            for (const file of files) {
                const target = path.join(root, file);
                entries.push({path: file, data: (await readFile(target)).toString("base64"), mode: (await lstat(target)).mode & 0o777});
            }
            if ((await signature(root, files)) === before) return {format: "zigbee2matter.fileset", version: 1, files: entries};
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }

    throw new Error("fileset: directory changed while reading; retry the backup");
}

/** 지정한 파일들만 읽는다(없는 파일은 건너뜀). */
export async function readNamedFileSet(root: string, names: readonly string[]): Promise<FileSet> {
    const files: FileSetEntry[] = [];
    for (const name of names) {
        try {
            const target = path.join(root, name);
            files.push({path: name, data: (await readFile(target)).toString("base64"), mode: (await lstat(target)).mode & 0o777});
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }

    return {format: "zigbee2matter.fileset", version: 1, files};
}

export function validateFileSet(set: unknown): asserts set is FileSet {
    if (!isFileSet(set)) throw new Error("invalid file set");
    const seen = new Set<string>();
    for (const file of set.files) {
        if (typeof file?.path !== "string" || typeof file.data !== "string") throw new Error("invalid file set entry");
        const segments = file.path.split("/");
        if (
            file.path.length === 0 ||
            file.path.includes("\\") ||
            file.path.startsWith("/") ||
            /^[A-Za-z]:/.test(file.path) ||
            segments.some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
            throw new Error("file set entry path is unsafe");
        }
        if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) {
            throw new Error("invalid file set entry");
        }
        if (seen.has(file.path)) throw new Error("file set entry is duplicated");
        seen.add(file.path);
    }
}

/** 파일 집합을 새 디렉터리에 쓴다(디렉터리 0700, 파일은 원본 권한 보존·기본 0600). 대상 디렉터리는 비어 있거나 없어야 한다. */
export async function writeFileSet(directory: string, set: FileSet): Promise<void> {
    validateFileSet(set);
    await mkdir(directory, {recursive: true, mode: 0o700});
    for (const file of set.files) {
        const target = path.join(directory, ...file.path.split("/"));
        await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
        // 원본 권한을 보존하되 소유자 읽기/쓰기는 보장하고 그룹/기타 쓰기 비트는 제거한다.
        const mode = file.mode === undefined ? 0o600 : (file.mode | 0o600) & 0o755;
        await writeFile(target, Buffer.from(file.data, "base64"), {mode});
        await chmod(target, mode);
    }
}

/** `directory`를 `stage`로 원자적 교체한다. 기존은 `<directory>.bak`로 보존(이전 .bak는 폐기). */
export async function swapDirectory(directory: string, stage: string): Promise<void> {
    const backup = `${directory}.bak`;
    let hadCurrent = true;
    try {
        await lstat(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hadCurrent = false;
    }
    if (hadCurrent) {
        await rm(backup, {recursive: true, force: true});
        await rename(directory, backup);
    }
    try {
        await rename(stage, directory);
    } catch (error) {
        if (hadCurrent) await rename(backup, directory);
        throw error;
    }
}

export function temporarySibling(directory: string, label: string): string {
    return `${directory}.${label}-${process.pid}-${randomUUID()}`;
}
