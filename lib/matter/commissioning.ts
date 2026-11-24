/**
 * Matter 등록 창과 Fabric 수명주기의 실행 경계(T033/T034).
 *
 * 창 열기/닫기와 fabric 목록/제거는 SDK(`CommissioningBackend`, sdkRuntime.ts 구현)가 소유한다.
 * 이 manager는 SDK 상태 위에 관리자 식별자·만료 메타데이터만 얹는다(자체 fabric 저장 없음).
 */
import {randomUUID} from "node:crypto";

export interface CommissioningWindow {
    readonly id: string;
    readonly discriminator: number;
    readonly setupCode: string;
    readonly openedAt: number;
    readonly expiresAt: number;
    readonly administratorId: string;
}

export interface CommissioningCode {
    readonly setupCode: string;
    readonly discriminator: number;
}

/** SDK가 보고하는 fabric. addedAt 같은 SDK에 없는 값은 만들지 않는다. */
export interface FabricRecord {
    readonly fabricIndex: number;
    readonly fabricId: string;
    readonly nodeId: string;
    readonly rootVendorId: number;
    readonly label: string;
}

export type FabricChangeAction = "added" | "deleted" | "updated";

/** SDK 실행 경계. 구현은 MatterSdkRuntime.commissioningBackend(). */
export interface CommissioningBackend {
    /** SDK commissioning window를 열고 그 창의 pairing code를 반환한다. */
    openWindow(durationMs: number): Promise<CommissioningCode>;
    /** SDK window를 닫는다. 열려 있지 않으면 false. */
    closeWindow(): Promise<boolean>;
    isWindowOpen(): boolean;
    listFabrics(): FabricRecord[];
    removeFabric(fabricIndex: number): Promise<boolean>;
    onFabricsChanged?(listener: (fabricIndex: number, action: FabricChangeAction) => void): () => void;
}

export interface CommissioningWindowOptions {
    readonly backend: CommissioningBackend;
    readonly now?: () => number;
    readonly idFactory?: () => string;
}

export class CommissioningManager {
    private readonly backend: CommissioningBackend;
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private window?: CommissioningWindow;

    constructor(options: CommissioningWindowOptions) {
        this.backend = options.backend;
        this.now = options.now ?? Date.now;
        this.idFactory = options.idFactory ?? randomUUID;
    }

    async openWindow(administratorId: string, durationMs: number): Promise<CommissioningWindow> {
        if (!administratorId) throw new Error("administratorId is required");
        if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("durationMs must be positive");

        const openedAt = this.clock();
        if (!Number.isSafeInteger(openedAt + durationMs)) throw new Error("commissioning clock value is invalid");
        const code = await this.backend.openWindow(durationMs);
        const validCode =
            code &&
            typeof code.setupCode === "string" &&
            code.setupCode.length > 0 &&
            Number.isSafeInteger(code.discriminator) &&
            code.discriminator >= 0 &&
            code.discriminator <= 4095;
        if (!validCode) throw new Error("Matter setup-code provider returned an invalid code");
        const next: CommissioningWindow = {
            id: this.idFactory(),
            discriminator: code.discriminator,
            setupCode: code.setupCode,
            openedAt,
            expiresAt: openedAt + durationMs,
            administratorId,
        };
        this.window = next;
        return {...next};
    }

    async closeWindow(): Promise<boolean> {
        this.window = undefined;
        return await this.backend.closeWindow();
    }

    /** 이 manager가 연 창만 반환한다. SDK 창이 닫혔거나 만료됐으면 undefined. */
    getActiveWindow(): CommissioningWindow | undefined {
        if (!this.window || this.window.expiresAt <= this.clock() || !this.backend.isWindowOpen()) {
            this.window = undefined;
            return undefined;
        }
        return {...this.window};
    }

    /** SDK fabric 상태를 그대로 반영한다. */
    listFabrics(): FabricRecord[] {
        return this.backend.listFabrics();
    }

    async removeFabric(fabricIndex: number): Promise<boolean> {
        if (!Number.isSafeInteger(fabricIndex) || fabricIndex < 1) throw new Error("invalid fabricIndex");
        return await this.backend.removeFabric(fabricIndex);
    }

    onFabricsChanged(listener: (fabricIndex: number, action: FabricChangeAction) => void): () => void {
        return this.backend.onFabricsChanged?.(listener) ?? (() => {});
    }

    private clock(): number {
        const value = this.now();
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("commissioning clock value is invalid");

        return value;
    }
}
