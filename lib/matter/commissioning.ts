/** Matter 등록 창과 Fabric 수명주기의 실행 경계(T033/T034). */
import {randomUUID} from "node:crypto";

export interface CommissioningWindow {
    readonly id: string;
    readonly discriminator: number;
    readonly setupCode: string;
    readonly openedAt: number;
    readonly expiresAt: number;
    readonly administratorId: string;
}

export interface CommissioningWindowOptions {
    readonly now?: () => number;
    readonly idFactory?: () => string;
    /** SDK가 생성한 pairing code와 그 code에 포함된 discriminator를 함께 공급한다. */
    readonly codeFactory?: () => CommissioningCode;
}

export interface CommissioningCode {
    readonly setupCode: string;
    readonly discriminator: number;
}

export interface FabricRecord {
    readonly fabricId: string;
    readonly administratorId: string;
    readonly addedAt: number;
}

export class CommissioningManager {
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private readonly codeFactory: () => CommissioningCode;
    private window?: CommissioningWindow;
    private readonly fabrics = new Map<string, FabricRecord>();

    constructor(options: CommissioningWindowOptions = {}) {
        this.now = options.now ?? Date.now;
        this.idFactory = options.idFactory ?? randomUUID;
        this.codeFactory = options.codeFactory ?? (() => {
            throw new Error("Matter setup-code provider is required");
        });
    }

    openWindow(administratorId: string, durationMs: number): CommissioningWindow {
        if (!administratorId) throw new Error("administratorId is required");
        if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("durationMs must be positive");

        const openedAt = this.now();
        const code = this.codeFactory();
        if (!code || typeof code.setupCode !== "string" || code.setupCode.length === 0 || !Number.isSafeInteger(code.discriminator) || code.discriminator < 0 || code.discriminator > 4095) {
            throw new Error("Matter setup-code provider returned an invalid code");
        }
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

    closeWindow(): boolean {
        if (!this.window) return false;
        this.window = undefined;
        return true;
    }

    getActiveWindow(): CommissioningWindow | undefined {
        if (!this.window || this.window.expiresAt <= this.now()) {
            this.window = undefined;
            return undefined;
        }
        return {...this.window};
    }

    validateSetup(id: string, discriminator: number, setupCode: string): boolean {
        const active = this.getActiveWindow();
        return active !== undefined && active.id === id && active.discriminator === discriminator && active.setupCode === setupCode;
    }

    addFabric(fabric: FabricRecord): void {
        if (!fabric.fabricId || !fabric.administratorId) throw new Error("fabric identity is required");
        this.fabrics.set(fabric.fabricId, {...fabric});
    }

    removeFabric(fabricId: string): boolean {
        return this.fabrics.delete(fabricId);
    }

    listFabrics(): FabricRecord[] {
        return [...this.fabrics.values()].map((fabric) => ({...fabric}));
    }
}
