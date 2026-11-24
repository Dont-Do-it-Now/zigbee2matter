/**
 * BridgeBus port (T005). Replaces the former broker client as the object injected into every Extension.
 *
 * Carries the internal topic/payload protocol (`bridge/request/*`, `<name>/set|get`, `bridge/response/*`, `<name>` state, ...)
 * between Core/extensions and adapters (frontend WS, future Matter/HTTP). No broker is involved: topics are plain strings
 * kept for UI compatibility (decision Q1). Core must not import any adapter implementation (CONTRACTS C5).
 */

/**
 * Publish options. `clientOptions` nesting kept to minimize caller diff (T006 removed the broker-only fields).
 */
export interface BridgeBusPublishOptions {
    clientOptions: {
        /** Keep the message in the retained snapshot (`BridgeBus.retainedMessages`), replayed to late consumers. Empty payload clears. */
        retain?: boolean;
    };
    /** Prefix for the topic (internal constant, see `BASE_TOPIC`). */
    baseTopic: string;
    skipLog: boolean;
    meta: {isEntityState?: boolean};
}

export interface BridgeBusInfo {
    version: number | undefined;
    server: string;
}

export interface BridgeBusStats {
    connected: boolean;
    queued: number;
}

export interface BridgeBus {
    /** Retained snapshot, key = full topic (with base topic). Used for the initial state of new frontend clients. */
    readonly retainedMessages: {[s: string]: {topic: string; payload: string; options: BridgeBusPublishOptions}};
    readonly info: BridgeBusInfo;
    readonly stats: BridgeBusStats;

    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    /** Outbound: state/event/response. Emits `eventBus.bridgeBusMessagePublished`, updates the retained snapshot. */
    publish(topic: string, payload: string, options?: Partial<BridgeBusPublishOptions>): Promise<void>;
    /** Inbound: request from an adapter (WS, Matter, HTTP). `topic` includes the base topic. Dispatched via `eventBus.bridgeBusMessage`. */
    onMessage(topic: string, message: Buffer | string): void;
}
