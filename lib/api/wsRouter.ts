/** C4 WebSocket 라우팅 경계(T057). 기존 frontend WebSocket 서버에 연결한다. */
import type {IncomingMessage} from "node:http";
import WebSocket from "ws";
import type {BridgeEvent, EventStream} from "../events";
import {authorizeWebSocket, type ApiAuth} from "./auth";
import WsEventSession, {type WsSnapshot} from "./wsSession";

export interface WsRouterOptions {
    readonly auth: ApiAuth;
    readonly stream: EventStream;
    readonly origin?: {allowedOrigins?: readonly string[]; allowSameHost?: boolean};
    readonly maxQueue?: number;
    readonly maxInboundMessages?: number;
    readonly inboundWindowMs?: number;
    readonly maxPayloadBytes?: number;
    readonly snapshot?: () => WsSnapshot;
}

export class WsApiRouter {
    constructor(private readonly options: WsRouterOptions) {}

    attach(server: WebSocket.Server): () => void {
        const onConnection = (socket: WebSocket, request: IncomingMessage): void => {
            const auth = authorizeWebSocket(this.options.auth, {
                headers: request.headers,
                url: request.url,
            }, {origin: this.options.origin, allowQueryToken: true});
            if (!auth.ok) {
                socket.close(auth.closeCode, auth.reason);
                return;
            }

            const session = new WsEventSession({maxQueue: this.options.maxQueue});
            const inboundWindowMs = Math.max(1, Math.floor(this.options.inboundWindowMs ?? 1_000));
            const maxInboundMessages = Math.max(1, Math.floor(this.options.maxInboundMessages ?? 60));
            const maxPayloadBytes = Math.max(1, Math.floor(this.options.maxPayloadBytes ?? 65_536));
            let inboundWindowStartedAt = Date.now();
            let inboundMessages = 0;
            let initializing = true;
            const bufferedEvents: BridgeEvent[] = [];
            const unsubscribe = this.options.stream.subscribe((event) => {
                if (initializing) bufferedEvents.push(event);
                else {
                    session.accept(event);
                    this.flush(socket, session);
                }
            });

            const snapshot = this.options.snapshot?.() ?? {
                epoch: this.options.stream.epoch,
                sequence: this.options.stream.lastSequence,
                payload: {},
            };
            session.acceptSnapshot(snapshot);
            session.acceptReplay(this.options.stream.replay(snapshot.sequence, snapshot.epoch));
            initializing = false;
            for (const event of bufferedEvents) {
                if (session.lastAcceptedSequence !== undefined && event.sequence <= session.lastAcceptedSequence) continue;
                session.accept(event);
            }
            this.flush(socket, session);
            const heartbeat = setInterval(() => {
                const frame = session.heartbeat();
                if (frame && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
            }, 30_000);

            const onMessage = (raw: WebSocket.RawData): void => {
                try {
                    const now = Date.now();
                    if (now - inboundWindowStartedAt >= inboundWindowMs) {
                        inboundWindowStartedAt = now;
                        inboundMessages = 0;
                    }
                    inboundMessages += 1;
                    if (inboundMessages > maxInboundMessages) {
                        socket.close(1008, "WebSocket message rate limit exceeded");
                        return;
                    }
                    if (Buffer.byteLength(raw.toString(), "utf8") > maxPayloadBytes) {
                        socket.close(1009, "WebSocket message too large");
                        return;
                    }
                    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
                    if (message.type === "replay") {
                        if (!isSequence(message.afterSequence)) throw new Error("invalid replay sequence");
                        session.acceptReplay(this.options.stream.replay(message.afterSequence, typeof message.epoch === "string" ? message.epoch : undefined));
                        this.flush(socket, session);
                    } else if (message.type === "snapshot-applied") {
                        if (typeof message.epoch !== "string" || message.epoch.length === 0 || !isSequence(message.sequence)) {
                            throw new Error("invalid snapshot sequence");
                        }
                        session.resetAfterSnapshot(message.epoch, message.sequence);
                    }
                } catch {
                    socket.send(JSON.stringify({type: "resync", reason: "invalid"}));
                }
            };

            socket.on("message", onMessage);
            socket.once("close", () => {
                clearInterval(heartbeat);
                unsubscribe();
            });
            socket.once("error", () => {
                clearInterval(heartbeat);
                unsubscribe();
            });
        };

        server.on("connection", onConnection);
        return () => server.off("connection", onConnection);
    }

    private flush(socket: WebSocket, session: WsEventSession): void {
        if (socket.readyState !== WebSocket.OPEN) return;
        for (const frame of session.drain()) socket.send(JSON.stringify(frame));
    }
}

function isSequence(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
