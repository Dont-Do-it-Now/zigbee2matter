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
    readonly value: unknown;
}

export class ReportingRegistry {
    private readonly subscriptions = new Map<string, ReportSubscription>();
    private readonly pending = new Map<string, ReportUpdate>();

    subscribe(input: Omit<ReportSubscription, "nextDueAt">, now = Date.now()): ReportSubscription {
        if (!input.id || !input.fabricId) throw new Error("subscription identity is required");
        if (!Number.isSafeInteger(input.minIntervalMs) || input.minIntervalMs < 0) throw new Error("invalid minIntervalMs");
        if (!Number.isSafeInteger(input.maxIntervalMs) || input.maxIntervalMs < input.minIntervalMs) throw new Error("invalid maxIntervalMs");
        const value = {...input, nextDueAt: now + input.minIntervalMs};
        this.subscriptions.set(input.id, value);
        return {...value};
    }

    unsubscribe(id: string): boolean {
        this.pending.delete(id);
        return this.subscriptions.delete(id);
    }

    publish(id: string, value: unknown, now = Date.now()): boolean {
        const subscription = this.subscriptions.get(id);
        if (!subscription) return false;
        this.pending.set(id, {subscriptionId: id, value});
        if (now >= subscription.nextDueAt) {
            this.subscriptions.set(id, {...subscription, nextDueAt: now});
        }
        return true;
    }

    drainDue(now = Date.now()): ReportUpdate[] {
        const due: ReportUpdate[] = [];
        for (const [id, subscription] of this.subscriptions) {
            if (subscription.nextDueAt > now) continue;
            const update = this.pending.get(id);
            if (update) {
                due.push(update);
                this.pending.delete(id);
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
