/**
 * Matter Device Attestation 정책 (T035).
 *
 * - SDK(@matter/*)를 import하지 않는 순수 설정 해석 모듈. 인증서/키 실물은 다루지 않고 "경로"만 해석한다.
 * - 실제 DeviceCertification 구성(파일 읽기 -> Bytes)은 SDK를 쓰는 lib/matter 어댑터(T039)가 수행한다.
 * - 개발 모드는 SDK 기본 동작(자동 생성 Test PAA/PAI/DAC + Test CD)에 맡긴다. 인증 우회/타사 VID 사칭 금지.
 * 근거: docs/evidence/T035.md
 */
import {isAbsolute, join} from "node:path";

/** Matter 테스트 Vendor ID 범위(0xFFF1 ~ 0xFFF4). */
export const TEST_VENDOR_ID_MIN = 0xfff1;
export const TEST_VENDOR_ID_MAX = 0xfff4;
/** SDK 기본값(BasicInformationServer: vendorId 65521, productId 32768). */
export const DEFAULT_VENDOR_ID = 0xfff1;
export const DEFAULT_PRODUCT_ID = 0x8000;

/** Attestation 자료 저장 하위 경로(SDK storage와 분리, C5). `<matterDir>/attestation`. */
export const ATTESTATION_DIR_NAME = "attestation";

export type AttestationMode = "development" | "custom";

/** 사용자 설정(configuration.yaml `matter.attestation`) 형태. 모든 값은 선택. */
export interface AttestationSettings {
    /** 기본 "development". */
    mode?: AttestationMode;
    vendorId?: number;
    productId?: number;
    /** custom 전용. 상대 경로면 attestation 디렉터리 기준. 파일 내용은 DER/바이너리, 설정에 인라인 금지. */
    dacPath?: string;
    paiPath?: string;
    cdPath?: string;
    dacPrivateKeyPath?: string;
    /** custom 전용: 사용자가 해당 VID의 정당한 사용권(CSA 회원 VID 또는 자체 보유)이 있음을 명시. */
    vendorIdOwnershipAcknowledged?: boolean;
}

export interface ResolvedAttestation {
    mode: AttestationMode;
    vendorId: number;
    productId: number;
    /** development: true -> SDK가 Test 인증서를 자동 생성(경로 없음). */
    useSdkGeneratedTestCertification: boolean;
    /** custom일 때만 존재. 절대 경로. */
    files?: {dac: string; pai: string; cd: string; dacPrivateKey: string};
    /** 커미셔닝 시 컨트롤러가 거부/경고할 수 있음을 알리는 안내(UI/로그용). */
    warnings: string[];
}

export class AttestationPolicyError extends Error {}

export function isTestVendorId(vendorId: number): boolean {
    return vendorId >= TEST_VENDOR_ID_MIN && vendorId <= TEST_VENDOR_ID_MAX;
}

function assertU16(name: string, v: number, min: number): void {
    if (!Number.isInteger(v) || v < min || v > 0xffff) {
        throw new AttestationPolicyError(`${name} must be an integer in ${min}..65535 (got ${v})`);
    }
}

/**
 * 설정을 검증하고 기본값을 해석한다. 실패 시 AttestationPolicyError(임의 fallback 없음).
 * @param matterDir Matter 데이터 루트(예: <ZIGBEE2MATTER_DATA>/matter). SDK storage와 다른 하위 디렉터리를 사용.
 */
export function resolveAttestation(settings: AttestationSettings | undefined, matterDir: string): ResolvedAttestation {
    const s = settings ?? {};
    const mode: AttestationMode = s.mode ?? "development";
    if (mode !== "development" && mode !== "custom") {
        throw new AttestationPolicyError(`unsupported attestation mode: ${String(mode)}`);
    }

    const vendorId = s.vendorId ?? DEFAULT_VENDOR_ID;
    const productId = s.productId ?? DEFAULT_PRODUCT_ID;
    assertU16("vendorId", vendorId, 1);
    assertU16("productId", productId, 1);

    const warnings: string[] = [];

    if (mode === "development") {
        if (!isTestVendorId(vendorId)) {
            const range = `0x${TEST_VENDOR_ID_MIN.toString(16)}-0x${TEST_VENDOR_ID_MAX.toString(16)}`;
            throw new AttestationPolicyError(
                `development mode requires a test vendorId (${range}); using another vendor's VID is not allowed`,
            );
        }
        if (s.dacPath || s.paiPath || s.cdPath || s.dacPrivateKeyPath) {
            throw new AttestationPolicyError("certificate paths are only valid in custom mode");
        }
        warnings.push(
            "development attestation: Test PAA/PAI/DAC and Test Certification Declaration. Not CSA certified; controllers may warn or refuse.",
        );
        return {mode, vendorId, productId, useSdkGeneratedTestCertification: true, warnings};
    }

    // custom
    if (isTestVendorId(vendorId)) {
        throw new AttestationPolicyError("custom mode must not use a test vendorId; use development mode instead");
    }
    if (s.vendorIdOwnershipAcknowledged !== true) {
        throw new AttestationPolicyError(
            "custom mode requires vendorIdOwnershipAcknowledged: true (VID must be legitimately yours)",
        );
    }
    const dir = join(matterDir, ATTESTATION_DIR_NAME);
    const {dacPath, paiPath, cdPath, dacPrivateKeyPath} = s;
    if (!dacPath) throw new AttestationPolicyError("custom mode requires dac path");
    if (!paiPath) throw new AttestationPolicyError("custom mode requires pai path");
    if (!cdPath) throw new AttestationPolicyError("custom mode requires cd path");
    if (!dacPrivateKeyPath) throw new AttestationPolicyError("custom mode requires dacPrivateKey path");
    const abs = (p: string): string => (isAbsolute(p) ? p : join(dir, p));
    warnings.push(
        "custom attestation: DAC/PAI/CD are user-supplied. Platform acceptance depends on the CD/PAA trust of each controller.",
    );
    return {
        mode,
        vendorId,
        productId,
        useSdkGeneratedTestCertification: false,
        files: {dac: abs(dacPath), pai: abs(paiPath), cd: abs(cdPath), dacPrivateKey: abs(dacPrivateKeyPath)},
        warnings,
    };
}
