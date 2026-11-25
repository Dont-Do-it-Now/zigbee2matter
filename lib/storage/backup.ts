/** 영속 snapshot의 암호화 envelope와 복원 경계 (T062). */
import {createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual} from "node:crypto";

const BACKUP_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
/** scrypt 파라미터(node 기본값). envelope에 기록하고 복원 시 동일한 값만 허용해 비용 조작(DoS)을 막는다. */
const SCRYPT_PARAMS = {N: 16384, r: 8, p: 1} as const;

/** 잘못된 입력(passphrase/envelope 손상)으로 인한 백업 오류. API 계층에서 INVALID_ARGUMENT로 매핑한다. 비밀은 담지 않는다. */
export class BackupInputError extends Error {
    readonly code = "INVALID_ARGUMENT" as const;

    constructor(message: string) {
        super(message);
        this.name = "BackupInputError";
    }
}

export interface BackupEnvelope {
    version: typeof BACKUP_VERSION;
    algorithm: typeof ALGORITHM;
    /** 구버전 envelope에는 없다(기본 파라미터로 간주). */
    kdf?: {name: "scrypt"; N: number; r: number; p: number};
    salt: string;
    iv: string;
    tag: string;
    checksum: string;
    ciphertext: string;
}

export const SNAPSHOT_SCHEMA = "zigbee2matter.snapshot" as const;
export const SNAPSHOT_VERSION = 1 as const;

/** identity/fabric/endpoint를 같은 일관된 snapshot으로 보존하기 위한 입력 경계. */
export interface PersistentSnapshot {
    schema: typeof SNAPSHOT_SCHEMA;
    version: typeof SNAPSHOT_VERSION;
    identity: unknown;
    fabric: unknown;
    endpointRegistry: unknown;
    /** Zigbee 필수 데이터(database.db, coordinator_backup.json, configuration.yaml, secret.yaml 등) 파일 집합. 구버전 snapshot에는 없다. */
    zigbee?: unknown;
}

export const MIN_PASSPHRASE_LENGTH = 12;

export function validatePassphrase(passphrase: unknown): asserts passphrase is string {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        throw new BackupInputError(`backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }
}

export function createBackup(payload: unknown, passphrase: string): string {
    validatePassphrase(passphrase);
    const key = deriveKey(passphrase, randomBytes(16));
    const serialized = JSON.stringify(payload);

    if (serialized === undefined) throw new Error("backup payload is not serializable");

    const plaintext = Buffer.from(serialized, "utf8");
    const cipher = createCipheriv(ALGORITHM, key.key, key.iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const checksum = createHash("sha256").update(plaintext).digest("hex");
    const envelope: BackupEnvelope = {
        version: BACKUP_VERSION,
        algorithm: ALGORITHM,
        kdf: {name: "scrypt", ...SCRYPT_PARAMS},
        salt: key.salt.toString("base64url"),
        iv: key.iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        checksum,
        ciphertext: ciphertext.toString("base64url"),
    };

    return JSON.stringify(envelope);
}

export function restoreBackup<T>(encoded: string, passphrase: string): T {
    let envelope: BackupEnvelope;
    try {
        envelope = JSON.parse(encoded) as BackupEnvelope;
    } catch {
        throw new BackupInputError("invalid backup envelope");
    }

    if (!isBackupEnvelope(envelope)) {
        throw new BackupInputError("unsupported or invalid backup envelope");
    }

    try {
        const salt = decodeBase64Url(envelope.salt, 16, 16);
        const iv = decodeBase64Url(envelope.iv, 12, 12);
        const tag = decodeBase64Url(envelope.tag, 16, 16);
        const ciphertext = decodeBase64Url(envelope.ciphertext, 1);
        const key = scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_PARAMS);
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const checksum = createHash("sha256").update(plaintext).digest();
        const expected = Buffer.from(envelope.checksum, "hex");

        if (expected.length !== checksum.length || !timingSafeEqual(checksum, expected)) {
            throw new Error("backup checksum mismatch");
        }

        return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
        throw new BackupInputError("backup decryption or validation failed");
    }
}

export function createSnapshotBackup(snapshot: PersistentSnapshot, passphrase: string): string {
    validatePersistentSnapshot(snapshot);

    return createBackup(snapshot, passphrase);
}

export function restoreSnapshotBackup(encoded: string, passphrase: string): PersistentSnapshot {
    const snapshot = restoreBackup<PersistentSnapshot>(encoded, passphrase);
    validatePersistentSnapshot(snapshot);

    return snapshot;
}

/** 동일 identity snapshot의 동시 생성/복원을 막는 프로세스 내 경계. */
export class BackupCoordinator {
    private running = false;

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.running) throw new Error("backup or restore is already running");

        this.running = true;
        try {
            return await operation();
        } finally {
            this.running = false;
        }
    }
}

function isBackupEnvelope(value: unknown): value is BackupEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

    const envelope = value as Partial<BackupEnvelope>;

    return (
        envelope.version === BACKUP_VERSION &&
        envelope.algorithm === ALGORITHM &&
        (envelope.kdf === undefined || isDefaultKdf(envelope.kdf)) &&
        typeof envelope.salt === "string" &&
        typeof envelope.iv === "string" &&
        typeof envelope.tag === "string" &&
        typeof envelope.ciphertext === "string" &&
        typeof envelope.checksum === "string" &&
        /^[0-9a-f]{64}$/.test(envelope.checksum)
    );
}

function isDefaultKdf(kdf: unknown): boolean {
    if (typeof kdf !== "object" || kdf === null) return false;
    const value = kdf as Record<string, unknown>;

    return value.name === "scrypt" && value.N === SCRYPT_PARAMS.N && value.r === SCRYPT_PARAMS.r && value.p === SCRYPT_PARAMS.p;
}

function decodeBase64Url(value: string, minimumLength: number, exactLength?: number): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid backup encoding");

    const decoded = Buffer.from(value, "base64url");

    if (decoded.length < minimumLength || (exactLength !== undefined && decoded.length !== exactLength)) {
        throw new Error("invalid backup encoding");
    }

    return decoded;
}

function validatePersistentSnapshot(snapshot: unknown): asserts snapshot is PersistentSnapshot {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        throw new BackupInputError("invalid persistent snapshot");
    }

    const value = snapshot as Partial<PersistentSnapshot>;

    if (
        value.schema !== SNAPSHOT_SCHEMA ||
        value.version !== SNAPSHOT_VERSION ||
        value.identity === undefined ||
        value.fabric === undefined ||
        value.endpointRegistry === undefined
    ) {
        throw new BackupInputError("persistent snapshot identity, fabric or endpoint registry is missing");
    }
}

function deriveKey(passphrase: string, salt: Buffer): {key: Buffer; salt: Buffer; iv: Buffer} {
    if (typeof passphrase !== "string" || passphrase.length === 0) throw new BackupInputError("backup passphrase is required");

    return {key: scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_PARAMS), salt, iv: randomBytes(12)};
}
