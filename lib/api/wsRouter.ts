/** C4 WebSocket 라우팅 경계(T057). 기존 frontend WebSocket 서버에 연결한다. */
import type {IncomingMessage} from "node:http";
import WebSocket from "ws";
import type {EventStream} from "../events";
import {authorizeWebSocket, type ApiAuth} from "./auth";
import WsEventSession from "./wsSession";

export interface WsRouterOptions {
    readonly auth: ApiAuth;
    readonly stream: EventStream;
    readonly origin?: {allowedOrigins?: readonly string[]; allowSameHost?: boolean};
    readonly maxQueue?: number;
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
            const unsubscribe = this.options.stream.subscribe((event) => {
                session.accept(event);
                this.flush(socket, session);
            });
            const heartbeat = setInterval(() => {
                const frame = session.heartbeat();
                if (frame && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
            }, 30_000);

            const onMessage = (raw: WebSocket.RawData): void => {
                try {
                    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
                    if (message.type === "replay" && typeof message.afterSequence === "number") {
                        session.acceptReplay(this.options.stream.replay(message.afterSequence, typeof message.epoch === "string" ? message.epoch : undefined));
                        this.flush(socket, session);
                    } else if (message.type === "snapshot-applied" && typeof message.epoch === "string" && typeof message.sequence === "number") {
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
