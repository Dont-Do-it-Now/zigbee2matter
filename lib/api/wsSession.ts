/** C4 EventStream을 WebSocket 세션 frame으로 전달하는 순수 경계 (T057). */
import type {BridgeEvent, ReplayResult} from "../events";

export type WsFrame =
    | {type: "event"; event: BridgeEvent}
    | {type: "snapshot"; epoch: string; sequence: number; payload: unknown}
    | {type: "resync"; reason: "gap" | "epoch" | "invalid" | "overflow" | "order"}
    | {type: "ping"};

export interface WsSnapshot {
    readonly epoch: string;
    readonly sequence: number;
    readonly payload: unknown;
}

export interface WsSessionOptions {
    maxQueue?: number;
    heartbeatMs?: number;
    now?: () => number;
}

export default class WsEventSession {
    private readonly queue: WsFrame[] = [];
    private readonly maxQueue: number;
    private readonly heartbeatMs: number;
    private readonly now: () => number;
    private epoch?: string;
    private lastSequence?: number;
    private lastHeartbeat: number;
    private resyncRequired = false;
    private resyncReason?: Extract<WsFrame, {type: "resync"}>["reason"];

    constructor(options: WsSessionOptions = {}) {
        const maxQueue = options.maxQueue ?? 100;
        const heartbeatMs = options.heartbeatMs ?? 30_000;
        if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new Error("maxQueue must be a positive integer");
        if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error("heartbeatMs must be a positive integer");
        this.now = options.now ?? Date.now;
        const initialNow = this.now();
        if (!Number.isSafeInteger(initialNow)) throw new Error("WebSocket clock is invalid");
        this.maxQueue = maxQueue;
        this.heartbeatMs = heartbeatMs;
        this.lastHeartbeat = initialNow;
    }

    accept(event: BridgeEvent): void {
        if (this.resyncRequired) return;
        if (this.epoch !== undefined && event.epoch !== this.epoch) return this.requireResync("epoch");
        if (this.lastSequence !== undefined && event.sequence <= this.lastSequence) return this.requireResync("order");
        if (this.lastSequence !== undefined && event.sequence !== this.lastSequence + 1) return this.requireResync("gap");

        if (this.queue.length >= this.maxQueue) return this.requireResync("overflow");

        this.epoch = event.epoch;
        this.lastSequence = event.sequence;
        this.queue.push({type: "event", event});
    }

    acceptReplay(result: ReplayResult): void {
        if (result.resync) return this.requireResync(result.reason);
        for (const event of result.events) this.accept(event);
    }

    acceptSnapshot(snapshot: WsSnapshot): void {
        if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || snapshot.epoch.length === 0) {
            return this.requireResync("invalid");
        }

        this.queue.length = 0;
        this.epoch = snapshot.epoch;
        this.lastSequence = snapshot.sequence;
        this.resyncRequired = false;
        this.resyncReason = undefined;
        this.queue.push({type: "snapshot", epoch: snapshot.epoch, sequence: snapshot.sequence, payload: snapshot.payload});
    }

    drain(): WsFrame[] {
        const frames = this.queue.splice(0);
        if (this.resyncRequired && frames.every((frame) => frame.type !== "resync")) {
            frames.push({type: "resync", reason: this.resyncReason ?? "invalid"});
        }

        return frames;
    }

    heartbeat(): WsFrame | undefined {
        const now = this.now();
        if (!Number.isSafeInteger(now)) throw new Error("WebSocket clock is invalid");
        if (now - this.lastHeartbeat < this.heartbeatMs) return undefined;

        this.lastHeartbeat = now;

        return {type: "ping"};
    }

    resetAfterSnapshot(epoch: string, sequence: number): void {
        if (epoch.length === 0 || sequence < 0 || !Number.isSafeInteger(sequence)) throw new Error("invalid snapshot sequence");

        this.queue.length = 0;
        this.epoch = epoch;
        this.lastSequence = sequence;
        this.resyncRequired = false;
        this.resyncReason = undefined;
    }

    get requiresResync(): boolean {
        return this.resyncRequired;
    }

    get lastAcceptedSequence(): number | undefined {
        return this.lastSequence;
    }

    private requireResync(reason: "gap" | "epoch" | "invalid" | "overflow" | "order"): void {
        this.resyncRequired = true;
        this.resyncReason = reason;
        this.queue.length = 0;
        this.queue.push({type: "resync", reason});
    }
}
