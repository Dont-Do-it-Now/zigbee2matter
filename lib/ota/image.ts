import {createHash} from "node:crypto";
import {basename} from "node:path";

export interface OtaImageInput {
    hex?: string;
    fileName?: string;
    url?: string;
}

export interface OtaImageValidation {
    valid: boolean;
    kind: "hex" | "url" | "registry";
    sizeBytes?: number;
    sha256?: string;
    reason?: string;
}

function validFileName(fileName: string | undefined): boolean {
    return (
        fileName === undefined ||
        (fileName.length > 0 && fileName !== "." && fileName !== ".." && basename(fileName) === fileName && !/[<>:"/\\|?*]/.test(fileName))
    );
}

/** 외부 입력의 OTA 이미지 참조만 검사한다. 이미지를 다운로드하거나 설치하지 않는다. */
export function validateOtaImage(input: OtaImageInput): OtaImageValidation {
    if (input.hex !== undefined && input.url !== undefined) {
        return {valid: false, kind: "hex", reason: "OTA image must provide either hex or URL, not both"};
    }

    if (input.hex !== undefined) {
        if (!validFileName(input.fileName)) {
            return {valid: false, kind: "hex", reason: "image file name must be a single safe path component"};
        }

        if (input.hex.length === 0 || input.hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(input.hex)) {
            return {valid: false, kind: "hex", reason: "hex image must be a non-empty even-length hexadecimal string"};
        }

        const bytes = Buffer.from(input.hex, "hex");
        return {
            valid: true,
            kind: "hex",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        };
    }

    if (input.url !== undefined) {
        try {
            const url = new URL(input.url);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                return {valid: false, kind: "url", reason: "OTA URL must use http or https"};
            }
            if (url.username || url.password) {
                return {valid: false, kind: "url", reason: "OTA URL must not contain credentials"};
            }
            return {valid: true, kind: "url"};
        } catch {
            return {valid: false, kind: "url", reason: "OTA URL is invalid"};
        }
    }

    return {valid: true, kind: "registry"};
}
