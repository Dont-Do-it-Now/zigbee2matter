/**
 * 기존 Z2M 데이터 이관 계획과 안전성 판정(T064).
 * 파일을 읽거나 복사하지 않고, 호출자가 수집한 메타데이터만 판정한다.
 */

export type ImportIssueSeverity = "pass" | "warn" | "block";
export type ImportIssueCode =
    | "PATH_INVALID"
    | "SOURCE_TARGET_COLLISION"
    | "SCHEMA_UNSUPPORTED"
    | "FILE_MISSING"
    | "FILE_DUPLICATE"
    | "FILE_OPTIONAL_MISSING"
    | "FILE_HASH_MISSING"
    | "MQTT_EXCLUDED"
    | "IDENTITY_INVALID"
    | "IDENTITY_MISMATCH"
    | "FRAME_COUNTER_UNKNOWN"
    | "FRAME_COUNTER_ROLLBACK"
    | "FRAME_COUNTER_INVALID";

export interface ImportIssue {
    severity: ImportIssueSeverity;
    code: ImportIssueCode;
    detail: string;
}

export type ImportFileRole =
    | "database"
    | "database-backup"
    | "coordinator-backup"
    | "configuration"
    | "devices"
    | "groups"
    | "secret"
    | "state"
    | "external-converter"
    | "external-extension";

/** 같은 역할로 여러 파일이 올 수 있는 역할(external_converters/, external_extensions/ 하위 파일). */
const MULTI_FILE_ROLES: ReadonlySet<ImportFileRole> = new Set(["external-converter", "external-extension"]);

export interface ImportFile {
    role: ImportFileRole;
    relativePath: string;
    sha256: string;
}

export interface ImportNetworkIdentity {
    ieeeAddr: string;
    panId: string;
    extendedPanId: string;
    channel: number;
    /** 원본 key 자체가 아니라, 동일성 확인을 위한 fingerprint만 받는다. */
    networkKeyFingerprint: string;
}

export interface ImportFrameCounter {
    source: number;
    target?: number;
}

export interface ImportDataInput {
    /** 생략하면 "plan"(사전검사). "execute"는 실제 쓰기 직전 검증이다. */
    phase?: "plan" | "execute";
    sourceDataDir: string;
    targetDataDir: string;
    sourceSchemaVersion: string;
    supportedSchemaVersions: readonly string[];
    files: readonly ImportFile[];
    sourceIdentity: ImportNetworkIdentity;
    targetIdentity?: ImportNetworkIdentity;
    frameCounter: ImportFrameCounter;
    configuration?: Readonly<Record<string, unknown>>;
    /** configuration.yaml이 `!secret`을 참조하면 true. secret.yaml 누락을 차단한다. */
    usesSecret?: boolean;
}

export interface ImportCopyAction {
    role: ImportFileRole;
    sourcePath: string;
    targetPath: string;
    sourceSha256: string;
    verifySourceUnchangedBeforeCommit: true;
}

export interface ImportConfigurationAction {
    /** 원본 configuration 파일의 SHA-256. 쓰기 직전 검증한다. */
    sourceSha256: string;
    sourcePath: string;
    targetPath: string;
    excludedTopLevelKeys: readonly ["mqtt"] | readonly [];
    configuration: Readonly<Record<string, unknown>>;
}

export interface ImportDataPlan {
    canProceed: boolean;
    ready: boolean;
    issues: readonly ImportIssue[];
    copyActions: readonly ImportCopyAction[];
    configuration?: ImportConfigurationAction;
    preserve: {
        networkKey: true;
        panId: true;
        extendedPanId: true;
        channel: true;
        ieeeAddr: true;
        frameCounter: true;
    };
    commitPolicy: "stage-then-atomic-promote";
    onFailure: "leave-source-unchanged";
}

/** upstream data 디렉터리(lib/util/data.ts, settings.ts) 기준 필수 항목. */
const REQUIRED_ROLES: readonly ImportFileRole[] = ["database", "coordinator-backup", "configuration"];
/** 없으면 상태/설정이 유실되므로 경고한다. */
const RECOMMENDED_ROLES: readonly ImportFileRole[] = ["state"];
const SHA256 = /^[0-9a-f]{64}$/i;
const IEEE = /^(?:0x)?[0-9a-f]{16}$/i;
const PAN_ID = /^(?:0x)?[0-9a-f]{4}$/i;
const EXTENDED_PAN_ID = /^(?:0x)?[0-9a-f]{16}$/i;
const KEY_FINGERPRINT = /^[0-9a-f]{64}$/i;

/** 호출자가 제공한 이관 자료로만 안전한 계획을 만든다. */
export function planImportData(input: ImportDataInput): ImportDataPlan {
    const issues: ImportIssue[] = [];
    const sourceDir = normalizePath(input.sourceDataDir);
    const targetDir = normalizePath(input.targetDataDir);

    if (!sourceDir || !targetDir) {
        issues.push({severity: "block", code: "PATH_INVALID", detail: "source와 target data 경로가 모두 필요합니다."});
    } else if (pathKey(sourceDir) === pathKey(targetDir)) {
        issues.push({severity: "block", code: "SOURCE_TARGET_COLLISION", detail: "source와 target data 경로가 같습니다."});
    }

    if (!input.supportedSchemaVersions.includes(input.sourceSchemaVersion)) {
        issues.push({severity: "block", code: "SCHEMA_UNSUPPORTED", detail: `schema '${input.sourceSchemaVersion}'은 지원 목록에 없습니다.`});
    }

    const filesByRole = new Map<ImportFileRole, ImportFile>();
    const copyFiles: ImportFile[] = [];
    const seenPaths = new Set<string>();
    for (const file of input.files) {
        if (!isSafeRelativePath(file.relativePath)) {
            issues.push({severity: "block", code: "PATH_INVALID", detail: `파일 경로 '${file.relativePath}'가 data 경계 밖입니다.`});
        }
        if (!SHA256.test(file.sha256)) {
            issues.push({severity: "block", code: "FILE_HASH_MISSING", detail: `파일 '${file.relativePath}'의 SHA-256이 없습니다.`});
        }
        const fileKey = file.relativePath.replaceAll("\\", "/").toLowerCase();
        if ((!MULTI_FILE_ROLES.has(file.role) && filesByRole.has(file.role)) || seenPaths.has(fileKey)) {
            issues.push({severity: "block", code: "FILE_DUPLICATE", detail: `파일 역할 '${file.role}' 또는 경로 '${file.relativePath}'가 중복됩니다.`});
        }
        seenPaths.add(fileKey);
        if (!filesByRole.has(file.role)) filesByRole.set(file.role, file);
        copyFiles.push(file);
    }

    for (const role of REQUIRED_ROLES) {
        if (!filesByRole.has(role)) {
            issues.push({severity: "block", code: "FILE_MISSING", detail: `필수 파일 역할 '${role}'가 없습니다.`});
        }
    }

    // configuration이 devices/groups를 별도 파일로 분리했으면 해당 파일도 필수다.
    for (const role of ["devices", "groups"] as const) {
        if (input.configuration && referencesFile(input.configuration[role]) && !filesByRole.has(role)) {
            issues.push({severity: "block", code: "FILE_MISSING", detail: `configuration이 '${role}' 파일을 참조하지만 이관 목록에 없습니다.`});
        }
    }
    if (input.usesSecret && !filesByRole.has("secret")) {
        issues.push({severity: "block", code: "FILE_MISSING", detail: "configuration이 secret을 참조하지만 secret 파일이 이관 목록에 없습니다."});
    }
    for (const role of RECOMMENDED_ROLES) {
        if (!filesByRole.has(role)) {
            issues.push({severity: "warn", code: "FILE_OPTIONAL_MISSING", detail: `파일 역할 '${role}'가 없습니다. 해당 상태는 이관되지 않습니다.`});
        }
    }

    checkIdentity(input.sourceIdentity, issues);
    if (input.targetIdentity) checkIdentityMatch(input.sourceIdentity, input.targetIdentity, issues);
    checkFrameCounter(input.frameCounter, issues, (input.phase ?? "plan") === "execute");

    const configurationFile = filesByRole.get("configuration");
    const configuration = input.configuration === undefined ? undefined : withoutMqtt(input.configuration);
    if (input.configuration && Object.prototype.hasOwnProperty.call(input.configuration, "mqtt")) {
        issues.push({severity: "pass", code: "MQTT_EXCLUDED", detail: "기존 configuration의 최상위 mqtt 설정은 이관 대상에서 제외합니다."});
    }

    const copyActions = copyFiles
        .filter((file) => file.role !== "configuration")
        .map((file) => ({
            role: file.role,
            sourcePath: joinPath(sourceDir, file.relativePath),
            targetPath: joinPath(targetDir, file.relativePath),
            sourceSha256: file.sha256,
            verifySourceUnchangedBeforeCommit: true as const,
        }));

    return {
        canProceed: !issues.some((issue) => issue.severity === "block"),
        ready: issues.length === 0,
        issues,
        copyActions,
        configuration:
            configurationFile && configuration
                ? {
                      sourceSha256: configurationFile.sha256,
                      sourcePath: joinPath(sourceDir, configurationFile.relativePath),
                      targetPath: joinPath(targetDir, configurationFile.relativePath),
                      excludedTopLevelKeys: Object.prototype.hasOwnProperty.call(input.configuration, "mqtt") ? (["mqtt"] as const) : ([] as const),
                      configuration,
                  }
                : undefined,
        preserve: {
            networkKey: true,
            panId: true,
            extendedPanId: true,
            channel: true,
            ieeeAddr: true,
            frameCounter: true,
        },
        commitPolicy: "stage-then-atomic-promote",
        onFailure: "leave-source-unchanged",
    };
}

function checkIdentity(identity: ImportNetworkIdentity, issues: ImportIssue[]): void {
    if (
        !IEEE.test(identity.ieeeAddr) ||
        !PAN_ID.test(identity.panId) ||
        !EXTENDED_PAN_ID.test(identity.extendedPanId) ||
        !KEY_FINGERPRINT.test(identity.networkKeyFingerprint)
    ) {
        issues.push({severity: "block", code: "IDENTITY_INVALID", detail: "IEEE, PAN, extended PAN 또는 network key fingerprint 형식이 잘못되었습니다."});
    }
    if (!Number.isInteger(identity.channel) || identity.channel < 11 || identity.channel > 26) {
        issues.push({severity: "block", code: "IDENTITY_INVALID", detail: "Zigbee channel은 11..26 정수여야 합니다."});
    }
}

function checkIdentityMatch(source: ImportNetworkIdentity, target: ImportNetworkIdentity, issues: ImportIssue[]): void {
    const same =
        normalizeHex(source.ieeeAddr) === normalizeHex(target.ieeeAddr) &&
        normalizeHex(source.panId) === normalizeHex(target.panId) &&
        normalizeHex(source.extendedPanId) === normalizeHex(target.extendedPanId) &&
        source.channel === target.channel &&
        source.networkKeyFingerprint.toLowerCase() === target.networkKeyFingerprint.toLowerCase();
    if (!same) {
        issues.push({severity: "block", code: "IDENTITY_MISMATCH", detail: "network key fingerprint, PAN, channel 또는 coordinator IEEE가 원본과 다릅니다."});
    }
}

function checkFrameCounter(frameCounter: ImportFrameCounter, issues: ImportIssue[], execute: boolean): void {
    if (
        !Number.isSafeInteger(frameCounter.source) ||
        frameCounter.source < 0 ||
        (frameCounter.target !== undefined &&
            (!Number.isSafeInteger(frameCounter.target) || frameCounter.target < 0))
    ) {
        issues.push({severity: "block", code: "FRAME_COUNTER_INVALID", detail: "frame counter는 0 이상의 안전한 정수여야 합니다."});
    } else if (frameCounter.target === undefined) {
        // 신규 target은 시작 전 counter가 없을 수 있어 계획 단계는 경고, 실제 쓰기 단계는 차단한다.
        issues.push({
            severity: execute ? "block" : "warn",
            code: "FRAME_COUNTER_UNKNOWN",
            detail: "target frame counter를 확인할 수 없어 rollback 안전성을 판정할 수 없습니다.",
        });
    } else if (frameCounter.target < frameCounter.source) {
        issues.push({severity: "block", code: "FRAME_COUNTER_ROLLBACK", detail: "target frame counter가 source보다 작아 rollback 위험이 있습니다."});
    }
}

function withoutMqtt(configuration: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const copy = {...configuration};
    delete copy.mqtt;
    return copy;
}

function isSafeRelativePath(value: string): boolean {
    const normalized = value.replaceAll("\\", "/");
    return (
        normalized.length > 0 &&
        !normalized.startsWith("/") &&
        !/^[a-zA-Z]:\//.test(normalized) &&
        !normalized.split("/").includes("..") &&
        normalized === normalized.replace(/\/+/g, "/")
    );
}

function referencesFile(value: unknown): boolean {
    return typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.some((item) => typeof item === "string");
}

/** 선행 `/`와 대소문자를 보존한다(POSIX 절대 경로, UNC 보존). 구분자만 `/`로 통일하고 중복/후행 구분자를 제거한다. */
function normalizePath(value: string): string {
    const unified = value.trim().replaceAll("\\", "/");
    const unc = unified.startsWith("//") && !unified.startsWith("///");
    const collapsed = unified.replace(/\/{2,}/g, "/");
    const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
    return unc ? `/${trimmed}` : trimmed;
}

/** Windows 경로(드라이브/UNC)만 대소문자 비교를 무시한다. POSIX 경로는 대소문자를 구분한다. */
function pathKey(path: string): string {
    return /^[a-zA-Z]:\//.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

function normalizeHex(value: string): string {
    return value.toLowerCase().replace(/^0x/, "").padStart(16, "0");
}

function joinPath(root: string, relativePath: string): string {
    return `${root}/${relativePath.replaceAll("\\", "/")}`;
}
