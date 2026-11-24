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

/** Matter SDK별 attribute subscription/report 호출을 주입하는 경계. */
export interface MatterReportingAdapter {
    subscribe(subscription: ReportSubscription): void;
    unsubscribe(subscription: ReportSubscription): void;
    report(update: ReportUpdate): void;
    onError?(error: unknown, update: ReportUpdate): void;
}

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

    restore(subscription: ReportSubscription): void {
        this.subscriptions.set(subscription.id, {...subscription});
    }

    pendingUpdate(id: string): ReportUpdate | undefined {
        const update = this.pending.get(id);
        return update === undefined ? undefined : {...update};
    }

    restorePending(update: ReportUpdate): void {
        this.pending.set(update.subscriptionId, {...update});
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

/** SDK runtime이 소유하는 fabric별 구독·보고 orchestration 경계. */
export class MatterReportingRuntime {
    constructor(
        private readonly adapter?: MatterReportingAdapter,
        readonly registry = new ReportingRegistry(),
    ) {
        this.registry.setDelivery((update) => this.adapter?.report(update));
        this.registry.setDeliveryError((error, update) => this.adapter?.onError?.(error, update));
    }

    subscribe(input: Omit<ReportSubscription, "nextDueAt">, now = Date.now()): ReportSubscription {
        const previous = this.registry.list().find((item) => item.id === input.id);
        const previousPending = previous === undefined ? undefined : this.registry.pendingUpdate(previous.id);
        if (previous) this.adapter?.unsubscribe(previous);

        let subscription: ReportSubscription | undefined;

        try {
            subscription = this.registry.subscribe(input, now);
            this.adapter?.subscribe(subscription);
        } catch (error) {
            if (subscription) this.registry.unsubscribe(subscription.id);
            if (previous) {
                this.registry.restore(previous);
                if (previousPending) this.registry.restorePending(previousPending);
                try {
                    this.adapter?.subscribe(previous);
                } catch {
                    // Preserve the original subscription error; adapter owns recovery diagnostics.
                }
            }
            throw error;
        }

        // The registry subscription succeeds together with the adapter subscription.
        if (!subscription) throw new Error("report subscription was not created");
        return subscription;
    }

    unsubscribe(id: string): boolean {
        const subscription = this.registry.list().find((item) => item.id === id);
        if (!subscription) return false;

        this.adapter?.unsubscribe(subscription);
        return this.registry.unsubscribe(id);
    }

    publish(id: string, value: unknown, now = Date.now()): boolean {
        return this.registry.publish(id, value, now);
    }

    drainDue(now = Date.now()): ReportUpdate[] {
        return this.registry.drainDue(now);
    }

    list(fabricId?: string): ReportSubscription[] {
        return this.registry.list(fabricId);
    }
}
