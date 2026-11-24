/** Fabric별 Matter 상태 보고 스케줄러 경계(T040). */

export interface ReportSubscription {
    readonly id: string;
    readonly fabricId: string;
    readonly minIntervalMs: number;
    readonly maxIntervalMs: number;
    readonly nextDueAt: number;
}

export interface ReportUpdate {
    readonly subscriptionId: string;
    /** 보고를 어느 fabric transport로 전달할지 식별한다. 기존 호출자 호환을 위해 optional이다. */
    readonly fabricId?: string;
    readonly value: unknown;
}

export type ReportDelivery = (update: ReportUpdate) => void;
export type ReportDeliveryError = (error: unknown, update: ReportUpdate) => void;

export class ReportingRegistry {
    private readonly subscriptions = new Map<string, ReportSubscription>();
    private readonly pending = new Map<string, ReportUpdate>();
    private delivery?: ReportDelivery;
    private deliveryError?: ReportDeliveryError;

    constructor(delivery?: ReportDelivery, deliveryError?: ReportDeliveryError) {
        this.delivery = delivery;
        this.deliveryError = deliveryError;
    }

    setDelivery(delivery: ReportDelivery | undefined): void {
        this.delivery = delivery;
    }

    setDeliveryError(deliveryError: ReportDeliveryError | undefined): void {
        this.deliveryError = deliveryError;
    }

    subscribe(input: Omit<ReportSubscription, "nextDueAt">, now = Date.now()): ReportSubscription {
        if (!input.id || !input.fabricId) throw new Error("subscription identity is required");
        if (!Number.isSafeInteger(input.minIntervalMs) || input.minIntervalMs < 0) throw new Error("invalid minIntervalMs");
        if (!Number.isSafeInteger(input.maxIntervalMs) || input.maxIntervalMs < input.minIntervalMs) throw new Error("invalid maxIntervalMs");
        if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + input.minIntervalMs)) throw new Error("invalid report clock");
        const value = {...input, nextDueAt: now + input.minIntervalMs};
        this.pending.delete(input.id);
        this.subscriptions.set(input.id, value);
        return {...value};
    }

    unsubscribe(id: string): boolean {
        this.pending.delete(id);
        return this.subscriptions.delete(id);
    }

    publish(id: string, value: unknown, now = Date.now()): boolean {
        if (!Number.isSafeInteger(now)) throw new Error("invalid report clock");
        const subscription = this.subscriptions.get(id);
        if (!subscription) return false;
        this.pending.set(id, {subscriptionId: id, fabricId: subscription.fabricId, value});
        if (now >= subscription.nextDueAt) {
            this.subscriptions.set(id, {...subscription, nextDueAt: now});
        }
        return true;
    }

    drainDue(now = Date.now()): ReportUpdate[] {
        if (!Number.isSafeInteger(now)) throw new Error("invalid report clock");
        for (const subscription of this.subscriptions.values()) {
            if (!Number.isSafeInteger(now + subscription.maxIntervalMs)) throw new Error("invalid report clock");
        }
        const due: ReportUpdate[] = [];
        for (const [id, subscription] of this.subscriptions) {
            if (subscription.nextDueAt > now) continue;
            const update = this.pending.get(id);
            if (update) {
                due.push(update);
                this.pending.delete(id);
                if (this.delivery) {
                    try {
                        this.delivery(update);
                    } catch (error) {
                        this.deliveryError?.(error, update);
                    }
                }
            }
            this.subscriptions.set(id, {...subscription, nextDueAt: now + subscription.maxIntervalMs});
        }
        return due;
    }

    list(fabricId?: string): ReportSubscription[] {
        return [...this.subscriptions.values()]
            .filter((subscription) => fabricId === undefined || subscription.fabricId === fabricId)
            .map((subscription) => ({...subscription}));
    }
}
