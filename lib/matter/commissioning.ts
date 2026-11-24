/** Matter 등록 창과 Fabric 수명주기의 실행 경계(T033/T034). */
import {randomInt, randomUUID} from "node:crypto";

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
    /** SDK가 생성한 유효한 Matter manual pairing code를 공급한다. 임의 숫자는 허용하지 않는다. */
    readonly codeFactory?: () => string;
}

export interface FabricRecord {
    readonly fabricId: string;
    readonly administratorId: string;
    readonly addedAt: number;
}

export class CommissioningManager {
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private readonly codeFactory: () => string;
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
        const next: CommissioningWindow = {
            id: this.idFactory(),
            discriminator: randomDiscriminator(),
            setupCode: this.codeFactory(),
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

function randomDiscriminator(): number {
    return randomInt(0, 4096);
}
