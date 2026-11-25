import assert from "node:assert";
import {existsSync, readFileSync} from "node:fs";
import type {IncomingMessage, Server, ServerResponse} from "node:http";
import {createServer} from "node:http";
import {createServer as createSecureServer} from "node:https";
import type {Socket} from "node:net";
import {join, posix} from "node:path";
import bind from "bind-decorator";
import WebSocket from "ws";
import QRCode from "qrcode";
import {ApiError, requireScope, safeEqual} from "../api/auth";
import type Matter from "./matter";
import {BASE_TOPIC} from "../bridgeBus/constants"; // z2m-fork: T006
import data from "../util/data";
import logger from "../util/logger";
import * as settings from "../util/settings";
import {createStaticFileServer, sendNotFound} from "../util/staticFileServer";
import {stringify} from "../util/stringify";
import {getMatterLocale} from "../util/matterLocale";
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
    const productBootstrap = `<script>
(() => {
    const contributionUrl = "https://github.com/Dont-Do-it-Now/zigbee2matter/blob/main/CONTRIBUTING.md";
    const replaceText = (textNode) => {
        const value = textNode.nodeValue?.trim();
        if (value === "Zigbee2MQTT") textNode.nodeValue = (textNode.nodeValue ?? "").replace(value, "Zigbee2Matter");
        if (value === "MQTT") textNode.nodeValue = (textNode.nodeValue ?? "").replace(value, "내부 메시지 경로");
    };
    const update = () => {
        document.title = document.title.replace("Zigbee2MQTT", "Zigbee2Matter");
        document.querySelectorAll("a[href*='donate']").forEach((original) => {
            const link = document.createElement("a");
            link.className = original.className;
            link.href = contributionUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.innerHTML = original.innerHTML;
            original.replaceWith(link);
        });
        if (!document.getElementById("z2m-matter-link")) {
            const donate = document.querySelector("a[href*='CONTRIBUTING.md']");
            const nav = donate?.parentElement ?? document.querySelector("nav, aside");
            if (nav) {
                const link = document.createElement("a");
                link.id = "z2m-matter-link";
                link.href = new URL("matter", location.href).pathname + location.search;
                link.textContent = "Matter 연결";
                link.style.cssText = "display:block;padding:16px;color:inherit;text-decoration:none";
                nav.insertBefore(link, donate ?? null);
            }
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            replaceText(node);
        }
    };
    new MutationObserver((mutations) => {
        if (mutations.some((mutation) => mutation.type === "childList")) update();
        else mutations.forEach((mutation) => replaceText(mutation.target));
    }).observe(document.documentElement, {childList: true, characterData: true, subtree: true});
    document.addEventListener("DOMContentLoaded", update, {once: true});
})();
</script>`;
    return index.replace("</head>", `${FRONTEND_LANGUAGE_BOOTSTRAP}${productBootstrap}</head>`);
}

const MATTER_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zigbee2Matter · Matter 연결</title>
<style>
:root{font-family:Inter,"Pretendard",system-ui,sans-serif;color:#17212b;background:#f7f8fa;font-synthesis:none}*{box-sizing:border-box}body{margin:0}.wrap{max-width:920px;margin:0 auto;padding:32px 24px 64px}a{color:#176b87}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 8px}h2{font-size:19px;margin:0 0 12px}.lead,.muted{color:#62717d;line-height:1.5}.card{background:#fff;border:1px solid #dce2e7;border-radius:12px;padding:24px;margin-top:24px}.row{display:flex;align-items:center;gap:24px;flex-wrap:wrap}.qr{width:224px;height:224px;object-fit:contain;border:1px solid #e2e7eb;border-radius:8px}.code{font:600 21px ui-monospace,monospace;letter-spacing:.08em}.input{width:min(100%,520px);padding:16px;border:1px solid #cbd4dc;border-radius:8px;font:inherit}.button{border:0;border-radius:8px;background:#087e9c;color:#fff;padding:8px 16px;font:inherit;cursor:pointer}.button.secondary{background:#e8f1f4;color:#14586c}.button.danger{background:#b73345}.button:disabled{opacity:.45;cursor:not-allowed}.fabric{display:flex;justify-content:space-between;align-items:center;gap:16px;border-top:1px solid #e5e9ed;padding:16px 0}.fabric:first-child{border-top:0}.guide{padding-left:22px;line-height:1.65}.status{padding:12px 16px;background:#eef5f7;border-radius:8px}.error{color:#a32739}.hidden{display:none!important}.back{display:inline-block;margin:0 0 24px;text-decoration:none}dialog{max-width:520px;border:1px solid #dce2e7;border-radius:12px;color:inherit}dialog::backdrop{background:rgba(18,28,38,.35)}
</style></head><body><main class="wrap"><a class="back" href="/">← Zigbee2Matter</a><h1>Matter 연결</h1><p class="lead">Zigbee 기기를 하나씩 연결하는 게 아니라, Zigbee2Matter 브리지를 Matter 플랫폼에 연결합니다. 여러 플랫폼에서 함께 쓰려면 기존 플랫폼의 공유 기능을 이용하세요.</p><section id="auth" class="card"><h2>관리자 인증</h2><p class="muted">Home Assistant 앱 설정의 API 토큰을 입력하세요. 토큰은 현재 화면에서만 사용합니다. 프론트엔드 인증 링크로 열었다면 자동 인증됩니다.</p><input id="token-input" class="input" type="password" autocomplete="current-password" aria-label="관리자 API 토큰"><button id="save-token" class="button">인증</button></section><div id="status" class="status">상태를 불러오는 중…</div><section id="first" class="card hidden"><h2>첫 Matter 연결</h2><p class="muted">Home Assistant Matter, Google Home, Apple Home 등에서 새 Matter 기기를 추가하고 아래 QR을 스캔하거나 코드를 입력하세요.</p><div id="pairing" class="row"></div><p id="expires" class="muted"></p><button id="open" class="button">연결 코드 만들기</button><button id="close" class="button secondary hidden">연결 창 닫기</button></section><section id="fabrics" class="card"><h2>연결된 Matter 플랫폼</h2><div id="fabric-list" class="muted">불러오는 중…</div></section><section id="share" class="card hidden"><h2>다른 Matter 플랫폼에 추가</h2><p class="muted">이미 연결된 플랫폼이 있다면 여기서 새 QR을 만들지 않습니다. 기존 플랫폼이 보안 공유 창을 열고 새 임시 코드를 발급해야 합니다.</p><ol class="guide"><li>현재 연결된 Home Assistant, Google Home 또는 Apple Home에서 Zigbee2Matter 브리지의 기기 설정을 엽니다.</li><li><b>다른 Matter 관리자와 공유</b> 또는 비슷한 이름의 메뉴를 선택하고 안내에 따라 공유 코드를 만듭니다.</li><li>추가할 플랫폼에서 Matter 기기 추가를 선택한 뒤, 기존 플랫폼이 표시한 QR을 스캔하거나 코드를 입력합니다.</li></ol><p class="muted">메뉴 이름은 플랫폼과 버전에 따라 다를 수 있습니다. 공유가 완료되면 이 화면의 연결 목록이 갱신됩니다.</p></section><section class="card"><h2>Home Assistant Matter Server</h2><p class="muted">Home Assistant에서 Matter를 사용하려면 Matter 통합과 Matter Server가 필요합니다. 이미 Matter Server 애드온/서버를 사용 중이면 새로 설치하지 말고 기존 서버를 연결하세요.</p><details><summary>이미 Matter Server가 있는 경우</summary><ol class="guide"><li>Home Assistant의 <a href="/config/integrations">설정 → 기기 및 서비스 → 통합</a>에서 Matter를 엽니다.</li><li>기존 Matter Server에 연결되어 있는지 확인한 뒤 Matter 기기 추가를 선택합니다.</li><li>위에서 만든 QR을 스캔하거나 수동 코드를 입력합니다.</li></ol></details><details><summary>Matter Server가 없는 경우</summary><ol class="guide"><li>Home Assistant 애드온 스토어에서 공식 Matter Server를 설치하고 실행합니다.</li><li>기기 및 서비스에서 Matter 통합을 추가하고 해당 Matter Server에 연결합니다.</li><li>Matter 기기 추가를 선택하고 위 QR 또는 수동 코드를 사용합니다.</li></ol></details></section><p id="error" class="error"></p></main><script>
document.querySelector(".back").href=new URL("./",location.href).pathname;const apiBase=new URL("matter-api/",location.href);const query=new URLSearchParams(location.search);let token=query.get("token");if(token){query.delete("token");const remainingQuery=query.toString();history.replaceState(null,"",location.pathname+(remainingQuery?"?"+remainingQuery:"")+location.hash)}const headers={"Content-Type":"application/json"};const getLanguage=()=>localStorage.getItem("i18nextLng")||navigator.language||"en";headers["Accept-Language"]=getLanguage();if(token)headers.Authorization="Bearer "+token;
const el=(id)=>document.getElementById(id);if(token)el("auth").classList.add("hidden");const showError=(e)=>{el("error").textContent=e.message||String(e)};async function call(path,options={}){const response=await fetch(new URL(path,apiBase),{...options,headers:{...headers,...options.headers}});const data=await response.json();if(!response.ok){const error=Error(data.error||"요청에 실패했습니다.");error.status=response.status;throw error}return data}
function renderWindow(window){el("pairing").replaceChildren();if(!window){el("expires").textContent="";el("open").classList.remove("hidden");el("close").classList.add("hidden");return}const image=document.createElement("img");image.className="qr";image.alt="Matter 연결 QR 코드";image.src=window.qrImage;const info=document.createElement("div");const label=document.createElement("p");label.textContent="수동 설정 코드";const code=document.createElement("p");code.className="code";code.textContent=window.setupCode;const disc=document.createElement("p");disc.className="muted";disc.textContent="확인용 discriminator: "+window.discriminator;info.append(label,code,disc);el("pairing").append(image,info);el("expires").textContent="연결 창은 약 "+Math.max(0,Math.ceil((window.expiresAt-Date.now())/1000))+"초 후 만료됩니다.";el("open").classList.add("hidden");el("close").classList.remove("hidden")}
async function refresh(){headers["Accept-Language"]=getLanguage();if(!token){el("auth").classList.remove("hidden");el("status").textContent="관리자 인증 후 Matter 상태를 표시합니다.";el("fabric-list").textContent="인증 후 연결 목록을 표시합니다.";el("first").classList.add("hidden");el("share").classList.add("hidden");return}try{el("error").textContent="";const data=await call("state");el("auth").classList.add("hidden");if(!data.matterRunning){el("status").textContent=data.reason||"Matter 브리지가 실행 중이 아닙니다. Matter 설정과 시작 로그를 확인하세요.";el("first").classList.add("hidden");el("share").classList.add("hidden");el("fabric-list").textContent="Matter 연결을 사용할 수 없습니다.";return}el("status").textContent="Matter 브리지 실행 중";el("first").classList.toggle("hidden",data.fabrics.length>0);el("share").classList.toggle("hidden",data.fabrics.length===0);const list=el("fabric-list");list.replaceChildren();if(!data.fabrics.length){list.textContent="아직 연결된 Matter 플랫폼이 없습니다."}else for(const fabric of data.fabrics){const row=document.createElement("div");row.className="fabric";const label=document.createElement("span");label.textContent=(fabric.label||"Matter 플랫폼")+" · 연결 "+fabric.fabricIndex;const button=document.createElement("button");button.className="button danger";button.textContent=data.disconnectMessages.disconnect;button.addEventListener("click",()=>removeFabric(fabric,data.disconnectMessages));row.append(label,button);list.append(row)}renderWindow(data.window)}catch(e){el("status").textContent="Matter 상태를 확인할 수 없습니다.";el("fabric-list").textContent="연결 목록을 불러오지 못했습니다.";el("first").classList.add("hidden");el("share").classList.add("hidden");if(e.status===401||e.status===403)el("auth").classList.remove("hidden");showError(e)}}
function removeFabric(fabric,messages){const dialog=document.createElement("dialog");const title=document.createElement("h2");title.textContent=messages.dialogTitle;const description=document.createElement("p");description.className="muted";description.textContent=messages.description.replace("{platform}",fabric.label||"Matter platform");const label=document.createElement("label");label.textContent=messages.confirmationPrompt;const input=document.createElement("input");input.className="input";input.autocomplete="off";const actions=document.createElement("div");actions.className="row";actions.style.marginTop="16px";const cancel=document.createElement("button");cancel.className="button secondary";cancel.textContent=messages.cancel;const submit=document.createElement("button");submit.className="button danger";submit.textContent=messages.disconnect;submit.disabled=true;input.addEventListener("input",()=>{submit.disabled=input.value!==messages.confirmationPhrase});cancel.addEventListener("click",()=>dialog.close());submit.addEventListener("click",async()=>{try{await call("fabrics/"+fabric.fabricIndex,{method:"DELETE",body:JSON.stringify({confirmation:input.value})});dialog.close();await refresh()}catch(e){showError(e)}});actions.append(cancel,submit);dialog.append(title,description,label,input,actions);dialog.addEventListener("close",()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal()}
el("save-token").addEventListener("click",async()=>{token=el("token-input").value.trim();if(!token){showError(Error("관리자 API 토큰을 입력하세요."));return}headers.Authorization="Bearer "+token;el("auth").classList.add("hidden");await refresh()});el("open").addEventListener("click",async()=>{try{const window=await call("commissioning",{method:"POST",body:JSON.stringify({})});renderWindow(window);await refresh()}catch(e){showError(e)}});el("close").addEventListener("click",async()=>{try{await call("commissioning",{method:"DELETE"});renderWindow(undefined);await refresh()}catch(e){showError(e)}});refresh();setInterval(refresh,10000);
</script></body></html>`;

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
        private readonly getExtension?: (name: string) => Extension | undefined,
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
                `Frontend UI serving is disabled. WebSocket at: ${this.wss.options.host ?? "0.0.0.0"}:${this.wss.options.port}${this.wss.options.path}`,
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
                const parsedUrl = new URL(url, "http://localhost");
                const newUrl = posix.relative(this.baseUrl, parsedUrl.pathname);

                // The request url is not within the frontend base url, so the relative path starts with '..'
                if (newUrl.startsWith(".")) {
                    sendNotFound(request, response);

                    return;
                }

                // The base url itself is a directory, redirect to its trailing slash form so the browser resolves the
                // relative asset paths in `index.html` against the frontend root instead of against its parent.
                if (newUrl === "" && !parsedUrl.pathname.endsWith("/")) {
                    response.writeHead(301, {Location: `${parsedUrl.pathname}/${parsedUrl.search}`});
                    response.end();

                    return;
                }

                if (newUrl === "matter/") {
                    const matterPath = `${this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`}matter`;
                    response.writeHead(301, {Location: `${matterPath}${parsedUrl.search}`});
                    response.end();
                    return;
                }

                if (newUrl === "matter") {
                    response.writeHead(200, {"Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8"});
                    response.end(MATTER_PAGE);
                    return;
                }

                if (newUrl === "matter-api" || newUrl.startsWith("matter-api/")) {
                    void this.handleMatterRequest(request, response, newUrl.slice("matter-api".length)).catch((error: unknown) => {
                        logger.error(`Matter frontend request failed: ${error instanceof Error ? error.message : String(error)}`);
                        if (!response.headersSent) this.writeMatterJson(response, 500, {error: "Matter 요청을 처리하지 못했습니다."});
                        else response.destroy();
                    });
                    return;
                }

                request.url = `/${newUrl}${parsedUrl.search}`;

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

    private async handleMatterRequest(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
        const matter = this.getExtension?.("Matter") as Matter | undefined;
        const authorization = request.headers.authorization;
        const suppliedToken = typeof authorization === "string" ? /^Bearer +(\S+)$/i.exec(authorization)?.[1] : undefined;
        const frontendToken = settings.get().frontend.auth_token;
        const origin = request.headers.origin;
        if (request.method !== "GET" && request.headers["sec-fetch-site"] === "cross-site") {
            this.writeMatterJson(response, 403, {error: "다른 사이트에서 시작한 요청은 허용되지 않습니다."});
            return;
        }
        if (request.method !== "GET" && origin) {
            try {
                const forwardedHostHeader = request.headers["x-forwarded-host"];
                const expectedHost = (Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader)?.split(",")[0]?.trim() ?? request.headers.host;
                if (new URL(origin).host.toLowerCase() !== expectedHost?.toLowerCase()) {
                    this.writeMatterJson(response, 403, {error: "다른 사이트에서 시작한 요청은 허용되지 않습니다."});
                    return;
                }
            } catch {
                this.writeMatterJson(response, 403, {error: "요청 출처를 확인할 수 없습니다."});
                return;
            }
        }
        if (!matter) {
            this.writeMatterJson(response, 503, {error: "Matter 관리 기능을 사용할 수 없습니다."});
            return;
        }
        let authenticatedByFrontend = Boolean(frontendToken && suppliedToken && safeEqual(frontendToken, suppliedToken));
        if (!authenticatedByFrontend) {
            if (!suppliedToken) {
                this.writeMatterJson(response, 401, {error: "관리자 API 토큰이 필요합니다. 앱 설정에서 API 토큰을 지정하세요."});
                return;
            }
            try {
                requireScope(matter.runtime.auth.authenticate(suppliedToken), "admin");
            } catch (error) {
                const status = error instanceof ApiError && error.code === "FORBIDDEN" ? 403 : 401;
                this.writeMatterJson(response, status, {error: status === 403 ? "관리자 권한이 필요합니다." : "유효한 관리자 API 토큰이 필요합니다."});
                return;
            }
        }
        if (!matter || !settings.get().matter.enabled || matter.degraded.has("matter")) {
            this.writeMatterJson(response, 503, {error: matter?.degraded.get("matter") ?? "Matter 브리지가 실행 중이 아닙니다."});
            return;
        }
        const runtime = matter.runtime;
        if (!runtime.matter.currentNode) {
            this.writeMatterJson(response, 503, {error: "Matter 노드가 아직 시작되지 않았습니다. 설정과 시작 로그를 확인하세요."});
            return;
        }

        if (request.method === "GET" && path === "/state") {
            const window = runtime.commissioning.getActiveWindow();
            const locale = getMatterLocale(request.headers["accept-language"]);
            this.writeMatterJson(response, 200, {
                matterRunning: true,
                fabrics: runtime.commissioning.listFabrics().map(({fabricIndex, label, rootVendorId}) => ({fabricIndex, label, rootVendorId})),
                window: window ? {...window, qrImage: await QRCode.toDataURL(window.qrCode, {margin: 2, width: 256, errorCorrectionLevel: "M"})} : undefined,
                disconnectMessages: locale,
            });
            return;
        }
        if (request.method === "POST" && path === "/commissioning") {
            if (runtime.commissioning.listFabrics().length > 0) {
                this.writeMatterJson(response, 409, {error: "추가 Matter 연결은 현재 연결된 플랫폼의 기기 공유 메뉴에서 시작하세요."});
                return;
            }
            const window = await runtime.commissioning.openWindow("frontend", 10 * 60_000);
            this.writeMatterJson(response, 201, {
                ...window,
                qrImage: await QRCode.toDataURL(window.qrCode, {margin: 2, width: 256, errorCorrectionLevel: "M"}),
            });
            return;
        }
        if (request.method === "DELETE" && path === "/commissioning") {
            this.writeMatterJson(response, 200, {closed: await runtime.commissioning.closeWindow()});
            return;
        }
        const fabricPath = /^\/fabrics\/(\d+)$/.exec(path);
        if (request.method === "DELETE" && fabricPath) {
            let body: Record<string, unknown>;
            try {
                body = await this.readMatterJson(request);
            } catch {
                this.writeMatterJson(response, 400, {error: "잘못된 연결 해제 요청입니다."});
                return;
            }
            const locale = getMatterLocale(request.headers["accept-language"]);
            if (body.confirmation !== locale.confirmationPhrase) {
                this.writeMatterJson(response, 400, {error: locale.invalidConfirmation});
                return;
            }
            const removed = await runtime.commissioning.removeFabric(Number(fabricPath[1]));
            this.writeMatterJson(response, removed ? 200 : 404, {removed});
            return;
        }
        this.writeMatterJson(response, 404, {error: "Matter 관리 경로를 찾을 수 없습니다."});
    }

    private writeMatterJson(response: ServerResponse, status: number, payload: unknown): void {
        const body = stringify(payload);
        response.writeHead(status, {"Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body)});
        response.end(body);
    }

    private async readMatterJson(request: IncomingMessage): Promise<Record<string, unknown>> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > 16_384) throw new Error("Matter request body too large");
            chunks.push(buffer);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Matter request body must be an object");
        return body as Record<string, unknown>;
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
