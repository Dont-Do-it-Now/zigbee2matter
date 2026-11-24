/** 독립 API 서버 수명주기(T053/T056/T057). */
import {createServer, type IncomingMessage, type Server} from "node:http";
import {createServer as createSecureServer} from "node:https";
import {readFileSync} from "node:fs";
import type {Duplex} from "node:stream";
import WebSocket from "ws";
import type {EventStream} from "../events";
import {RestApiRouter, type RestRouterDeps} from "./restRouter";
import {WsApiRouter} from "./wsRouter";
import type {WsSnapshot} from "./wsSession";

export interface ApiServerOptions extends RestRouterDeps {
    readonly stream: EventStream;
    /** 요청자에게만 보낼 snapshot. 이벤트 스트림에 snapshot 이벤트를 발행하지 않는 조회용(peek)이어야 한다(T021). */
    readonly snapshot?: () => WsSnapshot;
    readonly host?: string;
    readonly port: number;
    readonly tls?: {readonly certPath: string; readonly keyPath: string};
}

export class ApiServer {
    private http?: Server;
    private degraded?: string;
    private readonly websocket: WebSocket.Server;
    private readonly rest: RestApiRouter;
    private readonly ws: WsApiRouter;
    private listening = false;

    constructor(private readonly options: ApiServerOptions) {
        this.rest = new RestApiRouter(options);
        this.ws = new WsApiRouter({
            auth: options.auth,
            stream: options.stream,
            origin: options.origin,
            maxQueue: 100,
            maxInboundMessages: 60,
            inboundWindowMs: 1_000,
            maxPayloadBytes: 65_536,
            snapshot: options.snapshot,
        });
        this.websocket = new WebSocket.Server({noServer: true, maxPayload: 65_536});
        this.ws.attach(this.websocket);
    }

    /** TLS 설정/인증서 읽기 실패 시 API만 UNAVAILABLE(degraded)이 되고 서버는 listen하지 않는다. */
    get degradedReason(): string | undefined {
        return this.degraded;
    }

    private createHttp(): Server {
        const tls = this.options.tls;
        if (tls === undefined) return createServer((req, res) => this.rest.handle(req, res));
        if (!tls.certPath || !tls.keyPath) throw new Error("API TLS requires both cert and key");
        return createSecureServer({cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath)}, (req, res) =>
            this.rest.handle(req, res),
        );
    }

    async start(): Promise<void> {
        if (this.listening) return;
        let http: Server;
        try {
            http = this.createHttp();
        } catch (error) {
            this.degraded = `UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`;
            return;
        }
        this.degraded = undefined;
        http.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
        this.http = http;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                http.off("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                http.off("error", onError);
                this.listening = true;
                resolve();
            };
            http.once("error", onError);
            http.once("listening", onListening);
            if (this.options.host) http.listen(this.options.port, this.options.host);
            else http.listen(this.options.port);
        });
    }

    async stop(): Promise<void> {
        if (!this.listening) return;
        for (const client of this.websocket.clients) client.terminate();
        const http = this.http;
        if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
        await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
        this.listening = false;
    }

    address(): ReturnType<Server["address"]> {
        return this.http?.address() ?? null;
    }

    private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        let pathname: string;
        try {
            pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
        } catch {
            socket.destroy();
            return;
        }
        // REST와 같은 정책: 끝 `/` 하나만 허용(`/api/v1/events//`는 거부).
        if (pathname !== "/api/v1/events" && pathname !== "/api/v1/events/") {
            socket.destroy();
            return;
        }
        this.websocket.handleUpgrade(request, socket, head, (client) => {
            this.websocket.emit("connection", client, request);
        });
    }
}
