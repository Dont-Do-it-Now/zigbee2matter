/** 독립 API 서버 수명주기(T053/T056/T057). */
import {createServer, type IncomingMessage, type Server} from "node:http";
import {createServer as createSecureServer} from "node:https";
import {readFileSync} from "node:fs";
import type {Socket} from "node:net";
import WebSocket from "ws";
import type {EventStream} from "../events";
import {RestApiRouter, type RestRouterDeps} from "./restRouter";
import {WsApiRouter} from "./wsRouter";
import type {WsSnapshot} from "./wsSession";

export interface ApiServerOptions extends RestRouterDeps {
    readonly stream: EventStream;
    readonly snapshot?: () => WsSnapshot;
    readonly host?: string;
    readonly port: number;
    readonly tls?: {readonly certPath: string; readonly keyPath: string};
}

export class ApiServer {
    private readonly http: Server;
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
        if (options.tls !== undefined && (!options.tls.certPath || !options.tls.keyPath)) {
            throw new Error("API TLS requires both cert and key");
        }
        this.http = options.tls
            ? createSecureServer({cert: readFileSync(options.tls.certPath), key: readFileSync(options.tls.keyPath)}, (req, res) => this.rest.handle(req, res))
            : createServer((req, res) => this.rest.handle(req, res));
        this.websocket = new WebSocket.Server({noServer: true, maxPayload: 65_536});
        this.ws.attach(this.websocket);
        this.http.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    }

    async start(): Promise<void> {
        if (this.listening) return;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.http.off("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                this.http.off("error", onError);
                this.listening = true;
                resolve();
            };
            this.http.once("error", onError);
            this.http.once("listening", onListening);
            if (this.options.host) this.http.listen(this.options.port, this.options.host);
            else this.http.listen(this.options.port);
        });
    }

    async stop(): Promise<void> {
        if (!this.listening) return;
        for (const client of this.websocket.clients) client.terminate();
        await new Promise<void>((resolve) => this.http.close(() => resolve()));
        await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
        this.listening = false;
    }

    address(): ReturnType<Server["address"]> {
        return this.http.address();
    }

    private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
        const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
        if (pathname !== "/api/v1/events") {
            socket.destroy();
            return;
        }
        this.websocket.handleUpgrade(request, socket, head, (client) => {
            this.websocket.emit("connection", client, request);
        });
    }
}
