import type {EventStream} from "./eventStream";
import type {BridgeEvent} from "./types";

export type Platform = "matter" | "http" | "ws" | "internal";
export type PlatformListener = (event: BridgeEvent) => Promise<void> | void;

export interface PlatformFanoutOptions {
    maxQueue?: number;
    onDrop?: (drop: {id: string; platform: Platform; event: BridgeEvent; reason: "transient" | "state"}) => void;
    onError?: (error: unknown, consumer: {id: string; platform: Platform}) => void;
}

export interface PlatformConsumerStats {
    queued: number;
    dropped: number;
    errors: number;
}

interface Registration {
    id: string;
    platform: Platform;
    listener: PlatformListener;
    unsubscribeFromStream: () => void;
    queue: BridgeEvent[];
    maxQueue: number;
    onDrop?: PlatformFanoutOptions["onDrop"];
    onError?: PlatformFanoutOptions["onError"];
    running: boolean;
    active: boolean;
    /** T017: 이벤트가 드롭되었으므로 큐가 비면 소비자에게 resync(snapshot) 신호를 한 번 전달한다. */
    resyncPending: boolean;
    stats: PlatformConsumerStats;
}

/** T016/T017 platform fan-out with isolated bounded consumer queues. */
export default class PlatformFanout {
    private readonly registrations = new Map<string, Registration>();

    constructor(private readonly stream: EventStream) {}

    subscribe(id: string, platform: Platform, listener: PlatformListener, options: PlatformFanoutOptions = {}): () => void {
        if (id.length === 0 || this.registrations.has(id)) {
            throw new Error(`platform listener id is already registered: ${id}`);
        }

        const registration: Registration = {
            id,
            platform,
            listener,
            unsubscribeFromStream: () => {},
            queue: [],
            maxQueue: validateQueueLimit(options.maxQueue ?? 100),
            onDrop: options.onDrop,
            onError: options.onError,
            running: false,
            active: true,
            resyncPending: false,
            stats: {queued: 0, dropped: 0, errors: 0},
        };
        registration.unsubscribeFromStream = this.stream.subscribe((event) => this.enqueue(registration, event));
        this.registrations.set(id, registration);

        return () => this.unsubscribe(id);
    }

    unsubscribe(id: string): boolean {
        const registration = this.registrations.get(id);
        if (!registration) {
            return false;
        }

        registration.active = false;
        registration.queue.length = 0;
        registration.unsubscribeFromStream();
        this.registrations.delete(id);

        return true;
    }

    count(platform?: Platform): number {
        if (platform === undefined) {
            return this.registrations.size;
        }

        return [...this.registrations.values()].filter((registration) => registration.platform === platform).length;
    }

    stats(id: string): PlatformConsumerStats | undefined {
        const registration = this.registrations.get(id);

        return registration ? {...registration.stats, queued: registration.queue.length} : undefined;
    }

    clear(): void {
        for (const id of [...this.registrations.keys()]) {
            this.unsubscribe(id);
        }
    }

    private enqueue(registration: Registration, event: BridgeEvent): void {
        if (!registration.active) {
            return;
        }

        if (registration.queue.length >= registration.maxQueue) {
            const stateIndex = event.type === "transient" ? -1 : registration.queue.findIndex((queued) => queued.type !== "transient");
            const matchingStateIndex = event.type === "transient"
                ? -1
                : registration.queue.findIndex((queued) => queued.type === event.type && queued.key === event.key);

            if (matchingStateIndex >= 0) {
                // Keep the replacement at the tail so queued sequence numbers stay monotonic.
                // Replacing in place could deliver a newer event before an older queued event.
                const [dropped] = registration.queue.splice(matchingStateIndex, 1);
                registration.queue.push(event);
                registration.stats.dropped += 1;
                this.reportDrop(registration, dropped, "state");
            } else if (stateIndex >= 0) {
                const [dropped] = registration.queue.splice(stateIndex, 1);
                registration.queue.push(event);
                registration.stats.dropped += 1;
                this.reportDrop(registration, dropped, "state");
            } else if (event.type !== "transient") {
                const [dropped] = registration.queue.splice(0, 1);
                registration.queue.push(event);
                registration.stats.dropped += 1;
                this.reportDrop(registration, dropped, "transient");
            } else {
                registration.stats.dropped += 1;
                this.reportDrop(registration, event, "transient");
            }
        } else {
            registration.queue.push(event);
        }

        registration.stats.queued = Math.max(registration.stats.queued, registration.queue.length);
        void this.pump(registration);
    }

    private async pump(registration: Registration): Promise<void> {
        if (registration.running) {
            return;
        }

        registration.running = true;

        try {
            while (registration.active) {
                let event = registration.queue.shift();
                if (!event && registration.resyncPending) {
                    registration.resyncPending = false;
                    event = {
                        epoch: this.stream.epoch,
                        sequence: this.stream.lastSequence,
                        type: "snapshot",
                        key: "bridge",
                        payload: {reason: "overflow"},
                    };
                }
                if (!event) {
                    break;
                }

                try {
                    await registration.listener(event);
                } catch (error) {
                    registration.stats.errors += 1;
                    try {
                        registration.onError?.(error, {id: registration.id, platform: registration.platform});
                    } catch {
                        // An error reporter must not stop the consumer queue.
                    }
                }
            }
        } finally {
            registration.running = false;
            if (registration.active && registration.queue.length > 0) {
                void this.pump(registration);
            }
        }
    }

    private reportDrop(registration: Registration, event: BridgeEvent, reason: "transient" | "state"): void {
        registration.resyncPending = true;
        try {
            registration.onDrop?.({id: registration.id, platform: registration.platform, event, reason});
        } catch {
            // A drop reporter must not affect other consumers.
        }
    }
}

function validateQueueLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxQueue must be a positive integer");

    return value;
}
