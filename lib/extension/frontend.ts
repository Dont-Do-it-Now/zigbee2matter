import assert from "node:assert";
import {existsSync, readFileSync} from "node:fs";
import type {IncomingMessage, Server, ServerResponse} from "node:http";
import {createServer} from "node:http";
import {createServer as createSecureServer} from "node:https";
import type {Socket} from "node:net";
import {join, posix} from "node:path";
import bind from "bind-decorator";
import WebSocket from "ws";
import {BASE_TOPIC} from "../bridgeBus/constants"; // z2m-fork: T006
import data from "../util/data";
import logger from "../util/logger";
import * as settings from "../util/settings";
import {createStaticFileServer, sendNotFound} from "../util/staticFileServer";
import {stringify} from "../util/stringify";
import utils from "../util/utils";
import Extension from "./extension";

const FRONTEND_LANGUAGE_BOOTSTRAP = `<script>
(() => {
    const languageStorageKey = "i18nextLng";
    const supportedLanguages = new Set([
        "bg",
        "ca",
        "cs",
        "da",
        "de",
        "en",
        "es",
        "eu",
        "fi",
        "fr",
        "hu",
        "it",
        "ja",
        "ko",
        "nl",
        "no",
        "pl",
        "ptbr",
        "ru",
        "sk",
        "sv",
        "tr",
        "ua",
        "vi",
        "zh",
        "zh-CN",
    ]);
    const languageAliases = new Map([["pt", "ptbr"], ["uk", "ua"]]);

    const getBrowserLanguage = () => {
        for (const language of navigator.languages ?? [navigator.language]) {
            const normalized = language.replace("_", "-");
            const exact = [...supportedLanguages].find((supported) => supported.toLowerCase() === normalized.toLowerCase());
            if (exact) return exact;

            const base = normalized.split("-")[0].toLowerCase();
            const baseLanguage = [...supportedLanguages].find((supported) => supported.toLowerCase() === base);
            if (baseLanguage) return baseLanguage;
            const aliasedLanguage = languageAliases.get(base);
            if (aliasedLanguage) return aliasedLanguage;
        }

        return "en";
    };

    try {
        const storedLanguage = window.localStorage.getItem(languageStorageKey);
        if (!storedLanguage) {
            window.localStorage.setItem(languageStorageKey, getBrowserLanguage());
        }
    } catch {
        // Ignore unavailable browser storage and keep the frontend fallback language.
    }
})();
</script>`;

function prepareFrontendIndex(index: string): string {
    return index.replace("</head>", `${FRONTEND_LANGUAGE_BOOTSTRAP}</head>`);
}

// z2m-fork: T006 windfront compat (Q1): the existing UI reads `mqtt.*` keys of `bridge/info` and `bridge/health`.
// WS adapter output only (Core responses use `bridgeBus`); never mutates the original payload.
function windfrontCompat<T>(topic: string, payload: T): T {
    if (payload == null || typeof payload !== "object") {
        return payload;
    }

    const p = payload as KeyValue;

    if (topic === "bridge/info") {
        return {...p, mqtt: p.bridgeBus, ...(p.config ? {config: {...p.config, mqtt: {base_topic: BASE_TOPIC}}} : {})} as T;
    }

    if (topic === "bridge/health") {
        return {...p, mqtt: p.bridgeBus} as T;
    }

    return payload;
}

/**
 * This extension servers the frontend
 */
export class Frontend extends Extension {
    private bridgeBusBaseTopic: string;
    private server: Server | undefined;
    private wss!: WebSocket.Server;
    private baseUrl: string;

    constructor(
        zigbee: Zigbee,
        bridgeBus: BridgeBus,
        state: State,
        publishEntityState: PublishEntityState,
        eventBus: EventBus,
        enableDisableExtension: (enable: boolean, name: string) => Promise<void>,
        restartCallback: () => Promise<void>,
        addExtension: (extension: Extension) => Promise<void>,
    ) {
        super(zigbee, bridgeBus, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension);

        const frontendSettings = settings.get().frontend;
        assert(frontendSettings.enabled, `Frontend extension created with setting 'enabled: false'`);
        this.baseUrl = frontendSettings.base_url;
        this.bridgeBusBaseTopic = BASE_TOPIC;
    }

    override async start(): Promise<void> {
        if (settings.get().frontend.disable_ui_serving) {
            const {host, port} = settings.get().frontend;
            this.wss = new WebSocket.Server({port, host, path: posix.join(this.baseUrl, "api")});

            logger.info(
                /* v8 ignore next */
                `Frontend UI serving is disabled. WebSocket at: ` +
                    `${this.wss.options.host ?? "0.0.0.0"}:${this.wss.options.port}${this.wss.options.path}`,
            );
        } else {
            const {host, port, ssl_key: sslKey, ssl_cert: sslCert} = settings.get().frontend;
            const hasSSL = (val: string | undefined, key: string): val is string => {
                if (val) {
                    if (existsSync(val)) {
                        return true;
                    }

                    logger.error(`Defined ${key} '${val}' file path does not exists, server won't be secured.`);
                }

                return false;
            };
            const frontend = (await import(settings.get().frontend.package)) as typeof import("zigbee2mqtt-frontend");
            const logError = logger.error.bind(logger);
            const fileServer = createStaticFileServer(frontend.default.getPath(), logError);
            const frontendIndex = prepareFrontendIndex(readFileSync(join(frontend.default.getPath(), "index.html"), "utf8"));
            const deviceIconsFileServer = createStaticFileServer(data.joinPath("device_icons"), logError);
            const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
                // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
                const url = request.url!;
                const newUrl = posix.relative(this.baseUrl, url);

                // The request url is not within the frontend base url, so the relative path starts with '..'
                if (newUrl.startsWith(".")) {
                    sendNotFound(request, response);

                    return;
                }

                // The base url itself is a directory, redirect to its trailing slash form so the browser resolves the
                // relative asset paths in `index.html` against the frontend root instead of against its parent.
                if (newUrl === "" && !url.endsWith("/")) {
                    response.writeHead(301, {Location: `${url}/`});
                    response.end();

                    return;
                }

                request.url = `/${newUrl}`;

                if (newUrl === "" || newUrl === "index.html") {
                    response.setHeader("Cache-Control", "no-store");
                    response.setHeader("Content-Type", "text/html; charset=utf-8");
                    response.setHeader("Content-Length", Buffer.byteLength(frontendIndex));
                    response.writeHead(200);
                    response.end(frontendIndex);

                    return;
                }

                if (newUrl.startsWith("device_icons/")) {
                    request.url = request.url.replace("/device_icons", "");

                    deviceIconsFileServer(request, response);
                } else {
                    fileServer(request, response);
                }
            };

            if (hasSSL(sslKey, "ssl_key") && hasSSL(sslCert, "ssl_cert")) {
                const serverOptions = {key: readFileSync(sslKey), cert: readFileSync(sslCert)};
                this.server = createSecureServer(serverOptions, onRequest);
            } else {
                this.server = createServer(onRequest);
            }

            this.server.on("upgrade", this.onUpgrade);

            if (!host) {
                this.server.listen(port);
                logger.info(`Started frontend on port ${port}`);
            } else if (host.startsWith("/")) {
                this.server.listen(host);
                logger.info(`Started frontend on socket ${host}`);
            } else {
                this.server.listen(port, host);
                logger.info(`Started frontend on port ${host}:${port}`);
            }

            this.wss = new WebSocket.Server({noServer: true, path: posix.join(this.baseUrl, "api")});
        }

        this.wss.on("connection", this.onWebSocketConnection);

        this.eventBus.onBridgeBusMessagePublished(this, this.onBridgeBusPublishMessageOrEntityState);
        this.eventBus.onPublishEntityState(this, this.onBridgeBusPublishMessageOrEntityState);
    }

    override async stop(): Promise<void> {
        await super.stop();

        if (this.wss) {
            for (const client of this.wss.clients) {
                client.send(stringify({topic: "bridge/state", payload: {state: "offline"}}));
                client.terminate();
            }

            this.wss.close();
        }

        await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)));
    }

    @bind private onUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
            // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
            const {searchParams} = new URL(request.url!, "http://localhost"); // dummy base, may not be absolute
            const authToken = settings.get().frontend.auth_token;

            if (!authToken || authToken === searchParams.get("token")) {
                this.wss.emit("connection", ws, request);
            } else {
                ws.close(4401, "Unauthorized");
            }
        });
    }

    @bind private onWebSocketConnection(ws: WebSocket): void {
        ws.on("error", (msg) => logger.error(`WebSocket error: ${msg.message}`));
        ws.on("message", (data: Buffer, isBinary: boolean) => {
            if (!isBinary && data) {
                const message = data.toString();

                try {
                    const {topic, payload} = JSON.parse(message);
                    this.bridgeBus.onMessage(`${this.bridgeBusBaseTopic}/${topic}`, Buffer.from(stringify(payload)));
                } catch {
                    logger.error(`Received invalid message from WebSocket: ${message}`);
                }
            }
        });

        for (const [topic, payload] of Object.entries(this.bridgeBus.retainedMessages)) {
            if (topic.startsWith(`${this.bridgeBusBaseTopic}/`)) {
                ws.send(
                    stringify({
                        // Send topic without base_topic
                        topic: topic.substring(this.bridgeBusBaseTopic.length + 1),
                        payload: windfrontCompat(
                            topic.substring(this.bridgeBusBaseTopic.length + 1),
                            utils.parseJSON(payload.payload, payload.payload),
                        ),
                    }),
                );
            }
        }

        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) {
            const payload = this.state.get(device);
            const lastSeen = settings.get().advanced.last_seen;

            if (lastSeen !== "disable") {
                payload.last_seen = utils.formatDate(/* v8 ignore next */ device.zh.lastSeen ?? 0, lastSeen);
            }

            if (device.zh.linkquality !== undefined) {
                payload.linkquality = device.zh.linkquality;
            }

            ws.send(stringify({topic: device.name, payload}));
        }
    }

    @bind private onBridgeBusPublishMessageOrEntityState(data: eventdata.BridgeBusMessagePublished | eventdata.PublishEntityState): void {
        let topic: string;
        let payload: KeyValue | string;

        if ("topic" in data) {
            // BridgeBusMessagePublished
            if (data.options.meta.isEntityState || !data.topic.startsWith(`${this.bridgeBusBaseTopic}/`)) {
                // Don't send entity state to frontend on `BridgeBusMessagePublished` event, this is handled by
                // `PublishEntityState` instead. Reason for this is to skip attribute messages when `output` is
                // set to `attribute` or `attribute_and_json`, we only want to send JSON entity states to the
                // frontend.
                return;
            }
            // Send topic without base_topic
            topic = data.topic.substring(this.bridgeBusBaseTopic.length + 1);
            payload = windfrontCompat(topic, utils.parseJSON(data.payload, data.payload));
        } else {
            // PublishEntityState
            topic = data.entity.name;
            payload = data.message;
        }

        for (const client of this.wss.clients) {
            /* v8 ignore start */
            if (client.readyState === WebSocket.OPEN) {
                /* v8 ignore stop */
                client.send(stringify({topic, payload}));
            }
        }
    }
}

export default Frontend;
