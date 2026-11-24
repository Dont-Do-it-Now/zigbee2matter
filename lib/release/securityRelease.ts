/** upstream 보안 패치·릴리스 복구 계약(T010). */

export type ChangeClass = "security" | "core" | "bridge" | "dependency" | "docs";

export interface ReleaseChange {
    readonly file: string;
    readonly changeClass: ChangeClass;
    readonly upstreamCandidate: boolean;
    readonly compatibilityRisk: "low" | "medium" | "high";
}

export interface ReleaseManifest {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly changes: readonly ReleaseChange[];
    readonly rollbackArtifact: string;
    readonly schemaVersion: number;
}

export function validateReleaseManifest(manifest: ReleaseManifest): void {
    if (!/^[0-9a-f]{7,64}$/i.test(manifest.baseSha) || !/^[0-9a-f]{7,64}$/i.test(manifest.candidateSha)) throw new Error("invalid release SHA");
    if (!manifest.rollbackArtifact || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) throw new Error("invalid rollback/schema metadata");
    if (manifest.changes.some((change) => change.changeClass === "security" && change.compatibilityRisk === "high" && !change.upstreamCandidate)) {
        throw new Error("high-risk security change requires an upstream candidate or explicit review");
    }
}

export function classifyRelease(manifest: ReleaseManifest): {security: number; highRisk: number; upstreamCandidates: number} {
    validateReleaseManifest(manifest);
    return {
        security: manifest.changes.filter((change) => change.changeClass === "security").length,
        highRisk: manifest.changes.filter((change) => change.compatibilityRisk === "high").length,
        upstreamCandidates: manifest.changes.filter((change) => change.upstreamCandidate).length,
    };
}
