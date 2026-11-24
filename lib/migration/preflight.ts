/** 이전 전 사전 검사. 파일 시스템과 Zigbee Core를 읽지 않는 순수 정책 모듈(T063). */

export type PreflightSeverity = "pass" | "warn" | "block";
export type PreflightCategory = "device" | "adapter" | "version" | "firmware" | "backup" | "path" | "conflict";

export interface PreflightIssue {
    category: PreflightCategory;
    severity: PreflightSeverity;
    code: string;
    detail: string;
}

export interface PreflightVersionInfo {
    zigbee2mqtt: string;
    herdsman?: string;
    converters?: string;
}

export interface PreflightDevice {
    ieeeAddr: string;
    name?: string;
    modelId?: string;
    supported?: boolean;
}

export interface PreflightAdapterInfo {
    adapter?: string;
    port?: string | null;
    transport?: "serial" | "tcp" | "mdns" | "socket" | "unknown";
    firmware?: string;
}

export interface PreflightPathInfo {
    sourceDataDir: string;
    targetDataDir: string;
    requiredBackups: readonly string[];
    availableBackups: readonly string[];
    files?: readonly string[];
}

export interface PreflightInput {
    versions: PreflightVersionInfo;
    supportedVersions?: Partial<Record<keyof PreflightVersionInfo, readonly string[]>>;
    adapter: PreflightAdapterInfo;
    supportedAdapters?: readonly string[];
    devices: readonly PreflightDevice[];
    paths: PreflightPathInfo;
    automationIds?: readonly string[];
}

export interface PreflightReport {
    canProceed: boolean;
    ready: boolean;
    issues: readonly PreflightIssue[];
}

/**
 * 수집 계층이 넘긴 읽기 전용 자료만 판정한다.
 * 경로 존재 여부나 backup 생성은 호출자가 수행하며, 비밀값은 이 모듈의 입력으로 받지 않는다.
 */
export function evaluatePreflight(input: PreflightInput): PreflightReport {
    const issues: PreflightIssue[] = [];

    checkVersions(input, issues);
    checkAdapter(input, issues);
    checkDevices(input, issues);
    checkBackupsAndPaths(input, issues);
    checkConflicts(input, issues);

    return {
        canProceed: !issues.some((issue) => issue.severity === "block"),
        ready: issues.length === 0,
        issues,
    };
}

function checkVersions(input: PreflightInput, issues: PreflightIssue[]): void {
    for (const key of ["zigbee2mqtt", "herdsman", "converters"] as const) {
        const value = input.versions[key];
        const supported = input.supportedVersions?.[key];

        if (value === undefined) {
            issues.push({category: "version", severity: "warn", code: "VERSION_UNKNOWN", detail: `${key} 버전을 확인할 수 없습니다.`});
        } else if (supported && !supported.includes(value)) {
            issues.push({category: "version", severity: "block", code: "VERSION_UNSUPPORTED", detail: `${key} 버전 '${value}'은 지원 목록에 없습니다.`});
        }
    }
}

function checkAdapter(input: PreflightInput, issues: PreflightIssue[]): void {
    const {adapter, supportedAdapters = ["deconz", "zstack", "zigate", "ezsp", "ember", "zboss", "zoh"]} = input;
    const transport = adapter.transport ?? "serial";

    if (adapter.adapter && !supportedAdapters.includes(adapter.adapter)) {
        issues.push({category: "adapter", severity: "block", code: "ADAPTER_UNSUPPORTED", detail: `adapter '${adapter.adapter}'은 지원 목록에 없습니다.`});
    }

    if ((transport === "tcp" || transport === "socket") && (!adapter.adapter || !adapter.port)) {
        issues.push({category: "adapter", severity: "block", code: "TCP_ADAPTER_REQUIRED", detail: "TCP/socket transport는 adapter와 port를 명시해야 합니다."});
    }

    if (transport === "mdns" && !adapter.adapter) {
        issues.push({category: "adapter", severity: "warn", code: "MDNS_ADAPTER_UNCONFIRMED", detail: "mDNS adapter 결과가 아직 확정되지 않았습니다."});
    }

    if (transport === "unknown") {
        issues.push({category: "adapter", severity: "block", code: "TRANSPORT_UNKNOWN", detail: "transport 종류를 판정할 수 없습니다."});
    }

    if (!adapter.firmware) {
        issues.push({category: "firmware", severity: "warn", code: "FIRMWARE_UNKNOWN", detail: "코디네이터 firmware 버전이 확인되지 않았습니다."});
    }
}

function checkDevices(input: PreflightInput, issues: PreflightIssue[]): void {
    const identities = new Set<string>();

    if (input.devices.length === 0) {
        issues.push({category: "device", severity: "warn", code: "NO_DEVICES", detail: "이전 대상 기기가 없습니다."});
    }

    for (const device of input.devices) {
        const identity = normalizeIdentity(device.ieeeAddr);
        if (!identity) {
            issues.push({category: "device", severity: "block", code: "DEVICE_ID_MISSING", detail: "IEEE 주소가 없는 기기가 있습니다."});
        } else if (identities.has(identity)) {
            issues.push({category: "conflict", severity: "block", code: "DUPLICATE_DEVICE_ID", detail: `IEEE 주소 '${identity}'가 중복됩니다.`});
        } else {
            identities.add(identity);
        }

        if (device.supported === false) {
            issues.push({category: "device", severity: "block", code: "DEVICE_UNSUPPORTED", detail: `기기 '${device.name ?? device.modelId ?? identity}'가 지원되지 않습니다.`});
        }
    }
}

function checkBackupsAndPaths(input: PreflightInput, issues: PreflightIssue[]): void {
    const {paths} = input;
    const source = normalizePath(paths.sourceDataDir);
    const target = normalizePath(paths.targetDataDir);

    if (!source || !target) {
        issues.push({category: "path", severity: "block", code: "DATA_PATH_MISSING", detail: "source/target data 경로가 필요합니다."});
    } else if (source === target) {
        issues.push({category: "path", severity: "block", code: "DATA_PATH_COLLISION", detail: "source와 target data 경로가 같습니다."});
    }

    const available = new Set(paths.availableBackups.map(normalizePath));
    for (const required of paths.requiredBackups) {
        if (!available.has(normalizePath(required))) {
            issues.push({category: "backup", severity: "block", code: "BACKUP_MISSING", detail: `필수 backup '${required}'가 없습니다.`});
        }
    }

    const seen = new Set<string>();
    for (const file of paths.files ?? []) {
        const normalized = normalizePath(file);
        if (seen.has(normalized)) {
            issues.push({category: "conflict", severity: "block", code: "DUPLICATE_PATH", detail: `파일 경로 '${file}'가 중복됩니다.`});
        }
        seen.add(normalized);
    }
}

function checkConflicts(input: PreflightInput, issues: PreflightIssue[]): void {
    const ids = new Set<string>();
    for (const id of input.automationIds ?? []) {
        const normalized = id.trim();
        if (!normalized || ids.has(normalized)) {
            issues.push({category: "conflict", severity: "block", code: "DUPLICATE_AUTOMATION_ID", detail: `automation ID '${id}'가 비어 있거나 중복됩니다.`});
        }
        ids.add(normalized);
    }
}

function normalizeIdentity(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, "");
}

function normalizePath(value: string): string {
    return value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
