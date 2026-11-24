/**
 * herdsman이 수집한 후보를 고르는 순수 정책(T024).
 * 후보 수집·포트 열기·LAN 검색은 이 모듈의 책임이 아니다.
 */

export type CoordinatorTransport = "serial" | "tcp";
export type CoordinatorCandidateOrigin = "configured" | "automatic";

export interface CoordinatorCandidate {
    id: string;
    transport: CoordinatorTransport;
    path: string;
    adapter?: string;
    origin?: CoordinatorCandidateOrigin;
    /** 플랫폼별 경로 표현을 호출자가 확정할 때만 지정한다. */
    isSerialById?: boolean;
}

export interface CoordinatorDiscoveryInput {
    candidates: readonly CoordinatorCandidate[];
    selectionId?: string;
}

export type CoordinatorDiscoveryStatus = "selected" | "needs-selection" | "none" | "invalid";

export interface CoordinatorDiscoveryResult {
    status: CoordinatorDiscoveryStatus;
    selected?: CoordinatorCandidate;
    candidates: readonly CoordinatorCandidate[];
    reason: string;
}

const SERIAL_BY_ID_PREFIX = "/dev/serial/by-id/";

/**
 * 자동 수집된 후보를 임의로 재검색하거나 수정하지 않고 선택 가능성만 판정한다.
 * TCP는 사용자가 명시한 주소·포트·adapter 후보만 통과시킨다.
 */
export function evaluateCoordinatorDiscovery(input: CoordinatorDiscoveryInput): CoordinatorDiscoveryResult {
    const duplicateIds = new Set<string>();
    const valid: CoordinatorCandidate[] = [];

    for (const candidate of input.candidates) {
        if (duplicateIds.has(candidate.id)) {
            continue;
        }

        duplicateIds.add(candidate.id);

        if (isValidCandidate(candidate)) {
            valid.push(candidate);
        }
    }

    if (input.selectionId !== undefined) {
        const selected = valid.find((candidate) => candidate.id === input.selectionId);

        if (selected) {
            return {status: "selected", selected, candidates: valid, reason: "user-selected"};
        }

        return {status: "invalid", candidates: valid, reason: "selection-not-found-or-invalid"};
    }

    if (valid.length === 0) {
        return {status: "none", candidates: [], reason: "no-valid-candidate"};
    }

    const serial = valid.filter((candidate) => candidate.transport === "serial");
    const byId = serial.filter(isSerialById);

    if (serial.length === valid.length && byId.length === 1) {
        return {status: "selected", selected: byId[0], candidates: valid, reason: "serial-by-id-priority"};
    }

    if (valid.length === 1) {
        return {status: "selected", selected: valid[0], candidates: valid, reason: "single-valid-candidate"};
    }

    return {status: "needs-selection", candidates: valid, reason: "ambiguous-candidates"};
}

function isSerialById(candidate: CoordinatorCandidate): boolean {
    return candidate.isSerialById === true || candidate.path.toLowerCase().startsWith(SERIAL_BY_ID_PREFIX);
}

function isValidCandidate(candidate: CoordinatorCandidate): boolean {
    if (!candidate.id || !candidate.path) {
        return false;
    }

    if (candidate.transport === "serial") {
        return true;
    }

    if (candidate.origin !== "configured" || typeof candidate.adapter !== "string" || candidate.adapter.length === 0) return false;

    const match = /^(?:tcp|socket):\/\/[^/:]+:(\d{1,5})$/.exec(candidate.path);

    return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= 65535;
}
