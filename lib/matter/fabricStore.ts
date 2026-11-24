/**
 * SDK storage 디렉터리를 파일 단위로 snapshot/복원하는 MatterFabricStore(T061/T062, C5).
 * SDK 내부 포맷은 해석·수정하지 않는다. snapshot은 쓰기 중 변경 감지(재시도), 복원은 stage 후 다음 Matter 시작 전에 디렉터리 교체한다.
 */
import {lstat, rename, rm} from "node:fs/promises";
import {readDirectoryFileSet, swapDirectory, temporarySibling, validateFileSet, writeFileSet} from "../storage/fileSet";
import type {MatterFabricStore} from "./sdkRuntime";

export class FileMatterFabricStore implements MatterFabricStore {
    constructor(private readonly directory: string) {}

    private get pending(): string {
        return `${this.directory}.restore-pending`;
    }

    async snapshot(): Promise<unknown> {
        return await readDirectoryFileSet(this.directory);
    }

    /** 실행 중인 SDK 저장소를 건드리지 않고 stage만 한다. 적용은 `applyPendingRestore()`(Matter 시작 전). */
    async restore(snapshot: unknown): Promise<void> {
        validateFileSet(snapshot);
        const stage = temporarySibling(this.directory, "stage");
        try {
            await writeFileSet(stage, snapshot);
            await rm(this.pending, {recursive: true, force: true});
            await rename(stage, this.pending);
        } catch (error) {
            await rm(stage, {recursive: true, force: true});
            throw error;
        }
    }

    /** Matter 시작 전에 호출한다. stage가 있으면 기존 디렉터리를 `.bak`로 보존하며 교체한다. 적용했으면 true. */
    async applyPendingRestore(): Promise<boolean> {
        try {
            await lstat(this.pending);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
        await swapDirectory(this.directory, this.pending);

        return true;
    }
}
