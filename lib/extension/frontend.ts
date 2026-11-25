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
import {commissionIntoMatterServer, getMatterServerStatus, isHaos, MatterServerError} from "../ha/matterServer";
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
    // FRONTEND_LANGUAGE_BOOTSTRAP has already stored the normalized language; only Korean is localized, English is the default.
    const isKorean = () => {
        try {
            return (window.localStorage.getItem("i18nextLng") ?? "").toLowerCase().startsWith("ko");
        } catch {
            return false;
        }
    };
    const replaceText = (textNode) => {
        const value = textNode.nodeValue?.trim();
        if (value === "Zigbee2MQTT") textNode.nodeValue = (textNode.nodeValue ?? "").replace(value, "Zigbee2Matter");
        if (value === "MQTT") textNode.nodeValue = (textNode.nodeValue ?? "").replace(value, isKorean() ? "내부 메시지 경로" : "Internal bus");
    };
    const update = () => {
        // Assigning document.title always replaces the <title> text node, which re-triggers the observer (infinite loop).
        if (document.title.includes("Zigbee2MQTT")) document.title = document.title.replace("Zigbee2MQTT", "Zigbee2Matter");
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
                link.textContent = isKorean() ? "Matter 연결" : "Matter connections";
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zigbee2Matter</title>
<style>
:root{font-family:Inter,"Pretendard",system-ui,sans-serif;color:#17212b;background:#f7f8fa;font-synthesis:none}*{box-sizing:border-box}body{margin:0}.wrap{max-width:920px;margin:0 auto;padding:32px 24px 64px}a{color:#176b87}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 8px}h2{font-size:19px;margin:0 0 12px}.lead,.muted{color:#62717d;line-height:1.5}.card{background:#fff;border:1px solid #dce2e7;border-radius:12px;padding:24px;margin-top:24px}.row{display:flex;align-items:center;gap:24px;flex-wrap:wrap}.qr{width:224px;height:224px;object-fit:contain;border:1px solid #e2e7eb;border-radius:8px}.code{font:600 21px ui-monospace,monospace;letter-spacing:.08em;margin:4px 0 8px}.input{width:min(100%,520px);padding:16px;border:1px solid #cbd4dc;border-radius:8px;font:inherit}.button{border:0;border-radius:8px;background:#087e9c;color:#fff;padding:8px 16px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block;margin:4px 8px 4px 0}.button.secondary{background:#e8f1f4;color:#14586c}.button.danger{background:#b73345}.button:disabled{opacity:.45;cursor:not-allowed}.fabric{display:flex;justify-content:space-between;align-items:center;gap:16px;border-top:1px solid #e5e9ed;padding:16px 0}.fabric:first-child{border-top:0}.guide{padding-left:22px;line-height:1.65}.status{padding:12px 16px;background:#eef5f7;border-radius:8px}.error{color:#a32739}.ok{color:#1d7a46}.hidden{display:none!important}.back{display:inline-block;margin:0 0 24px;text-decoration:none}dialog{max-width:520px;border:1px solid #dce2e7;border-radius:12px;color:inherit}dialog::backdrop{background:rgba(18,28,38,.35)}
</style></head><body><main class="wrap"><a class="back" href="/">&larr; Zigbee2Matter</a><h1 data-i18n="title"></h1><p class="lead" data-i18n="lead"></p>
<section id="auth" class="card hidden"><h2 data-i18n="authTitle"></h2><p class="muted" data-i18n="authHelp"></p><input id="token-input" class="input" type="password" autocomplete="current-password" data-i18n-label="authLabel"><button id="save-token" class="button" data-i18n="authButton"></button></section>
<div id="status" class="status"></div>
<section id="ha" class="card hidden"><h2 data-i18n="haTitle"></h2><p id="ha-state" class="muted"></p><button id="ha-connect" class="button"></button><a id="ha-install" class="button secondary hidden" target="_blank" rel="noopener noreferrer" data-i18n="haInstallLink"></a><a id="ha-integration" class="button secondary hidden" target="_blank" rel="noopener noreferrer" data-i18n="haIntegrationLink"></a><p id="ha-result" class="muted"></p></section>
<section id="pair" class="card hidden"><h2 id="pair-title"></h2><p class="muted" data-i18n="pairHelp"></p><div id="pairing" class="row"></div><p id="expires" class="muted"></p><button id="open" class="button"></button><button id="close" class="button secondary hidden" data-i18n="closeWindow"></button></section>
<section id="fabrics" class="card"><h2 data-i18n="platforms"></h2><div id="fabric-list" class="muted"></div></section>
<section class="card"><h2 data-i18n="guideTitle"></h2><ol class="guide"><li data-i18n="guide1"></li><li data-i18n="guide2"></li><li data-i18n="guide3"></li></ol></section>
<p id="error" class="error"></p></main><script>
var I18N = {
  en: {
    title: "Matter connections",
    lead: "Connect the Zigbee2Matter bridge to Matter platforms. You can connect several platforms at once (Home Assistant, Apple Home, Google Home, SmartThings...).",
    authTitle: "Administrator authentication",
    authHelp: "Enter the API token from the add-on settings. It is only used on this page.",
    authLabel: "Administrator API token",
    authButton: "Sign in",
    needToken: "Enter the administrator API token.",
    loading: "Loading status...",
    needAuth: "Authenticate to see the Matter status.",
    running: "Matter bridge is running.",
    notRunning: "The Matter bridge is not running. Check the Matter settings and the start-up log.",
    statusFailed: "Could not read the Matter status.",
    platforms: "Connected Matter platforms",
    noPlatforms: "No Matter platform is connected yet.",
    platformsUnavailable: "Matter connections are unavailable.",
    platformsFailed: "Could not load the connection list.",
    platformLabel: "{name} (fabric {index})",
    controller: "Matter controller #{vendor}",
    pairFirst: "Create pairing code",
    pairMore: "Add another platform",
    pairTitleFirst: "Connect your first platform",
    pairTitleMore: "Add another platform",
    pairHelp: "In Home Assistant, Apple Home, Google Home or SmartThings choose Add device > Matter, then scan the QR code or enter the code.",
    closeWindow: "Close pairing window",
    qrAlt: "Matter pairing QR code",
    manualCode: "Manual pairing code",
    copy: "Copy",
    copied: "Copied",
    expiresIn: "The pairing window expires in {time}.",
    expired: "The pairing window has expired.",
    disconnect: "Disconnect",
    dialogTitle: "Disconnect Matter platform",
    dialogDescription: "Disconnect only {platform}. Zigbee devices and other Matter platforms remain connected.",
    confirmPrompt: "Type {phrase} to continue.",
    cancel: "Cancel",
    haTitle: "Home Assistant",
    haChecking: "Checking the Matter Server add-on...",
    haNotInstalled: "The Home Assistant Matter Server add-on is not installed. Install it first, then come back and connect.",
    haStopped: "The Matter Server add-on is installed but not running. Start it from its add-on page, then reload this page.",
    haReady: "Matter Server is running. One click connects this bridge to Home Assistant.",
    haConnect: "Connect to Home Assistant",
    haConnecting: "Connecting... this can take up to 2 minutes.",
    haConnected: "Connected to Home Assistant. Open the Matter integration to see the devices.",
    haInstallLink: "Install Matter Server",
    haIntegrationLink: "Open Matter integration",
    "err.CROSS_SITE": "Requests started from another site are not allowed.",
    "err.ORIGIN_UNVERIFIED": "The request origin could not be verified.",
    "err.MATTER_UNAVAILABLE": "Matter management is unavailable.",
    "err.TOKEN_REQUIRED": "An administrator API token is required. Set one in the add-on settings.",
    "err.TOKEN_INVALID": "The administrator API token is not valid.",
    "err.ADMIN_REQUIRED": "Administrator permission is required.",
    "err.MATTER_NOT_RUNNING": "The Matter bridge is not running.",
    "err.NODE_NOT_STARTED": "The Matter node has not started yet. Check the settings and the start-up log.",
    "err.INVALID_REQUEST": "Invalid request.",
    "err.INVALID_CONFIRMATION": "The confirmation text does not match.",
    "err.NOT_FOUND": "Not found.",
    "err.INTERNAL": "The Matter request failed.",
    "err.NOT_HAOS": "This is only available in the Home Assistant add-on.",
    "err.BUSY": "A Home Assistant connection is already in progress.",
    "err.MATTER_SERVER_NOT_INSTALLED": "The Matter Server add-on is not installed.",
    "err.MATTER_SERVER_STOPPED": "The Matter Server add-on is not running. Start it from its add-on page.",
    "err.CONNECT_FAILED": "Could not connect to the Matter Server add-on.",
    "err.START_FAILED": "Could not start the Matter Server add-on.",
    "err.CONNECT_FAILED": "Could not reach the Matter Server.",
    "err.COMMISSION_FAILED": "Matter Server could not add this bridge.",
    "err.COMMISSION_TIMEOUT": "Matter Server did not finish in time.",
    "err.UNKNOWN": "The request failed.",
    guideTitle: "Adding another platform",
    guide1: "Press Add another platform here. A new pairing window opens.",
    guide2: "In the other app choose Add device > Matter and scan the QR code or enter the manual code.",
    guide3: "When pairing finishes the platform appears in the list above. Existing platforms stay connected."
  },
  ko: {
    title: "Matter 연결",
    lead: "Zigbee2Matter 브리지를 Matter 플랫폼에 연결합니다. Home Assistant, Apple 홈, Google Home, SmartThings 등 여러 플랫폼을 함께 연결할 수 있습니다.",
    authTitle: "관리자 인증",
    authHelp: "앱 설정의 API 토큰을 입력하세요. 토큰은 이 화면에서만 사용합니다.",
    authLabel: "관리자 API 토큰",
    authButton: "인증",
    needToken: "관리자 API 토큰을 입력하세요.",
    loading: "상태를 불러오는 중...",
    needAuth: "인증 후 Matter 상태를 표시합니다.",
    running: "Matter 브리지 실행 중",
    notRunning: "Matter 브리지가 실행 중이 아닙니다. Matter 설정과 시작 로그를 확인하세요.",
    statusFailed: "Matter 상태를 확인할 수 없습니다.",
    platforms: "연결된 Matter 플랫폼",
    noPlatforms: "아직 연결된 Matter 플랫폼이 없습니다.",
    platformsUnavailable: "Matter 연결을 사용할 수 없습니다.",
    platformsFailed: "연결 목록을 불러오지 못했습니다.",
    platformLabel: "{name} (연결 {index})",
    controller: "Matter 컨트롤러 #{vendor}",
    pairFirst: "연결 코드 만들기",
    pairMore: "다른 플랫폼 추가",
    pairTitleFirst: "첫 플랫폼 연결",
    pairTitleMore: "다른 플랫폼 추가",
    pairHelp: "Home Assistant, Apple 홈, Google Home, SmartThings에서 기기 추가 > Matter를 선택한 뒤 QR을 스캔하거나 코드를 입력하세요.",
    closeWindow: "연결 창 닫기",
    qrAlt: "Matter 연결 QR 코드",
    manualCode: "수동 설정 코드",
    copy: "복사",
    copied: "복사됨",
    expiresIn: "연결 창이 {time} 후 만료됩니다.",
    expired: "연결 창이 만료되었습니다.",
    disconnect: "연결 해제",
    dialogTitle: "Matter 연결 해제",
    dialogDescription: "{platform} 연결만 해제합니다. Zigbee 기기와 다른 Matter 플랫폼 연결은 삭제되지 않습니다.",
    confirmPrompt: "계속하려면 {phrase} 를 입력하세요.",
    cancel: "취소",
    haTitle: "Home Assistant",
    haChecking: "Matter Server 애드온을 확인하는 중...",
    haNotInstalled: "Home Assistant Matter Server 애드온이 설치되어 있지 않습니다. 먼저 설치한 뒤 다시 연결하세요.",
    haStopped: "Matter Server 애드온이 설치되어 있지만 실행 중이 아닙니다. 애드온 페이지에서 시작한 뒤 이 페이지를 새로고침하세요.",
    haReady: "Matter Server가 실행 중입니다. 버튼 한 번으로 Home Assistant에 연결합니다.",
    haConnect: "Home Assistant에 연결",
    haConnecting: "연결 중... 최대 2분 걸릴 수 있습니다.",
    haConnected: "Home Assistant에 연결되었습니다. Matter 통합에서 기기를 확인하세요.",
    haInstallLink: "Matter Server 설치",
    haIntegrationLink: "Matter 통합 열기",
    "err.CROSS_SITE": "다른 사이트에서 시작한 요청은 허용되지 않습니다.",
    "err.ORIGIN_UNVERIFIED": "요청 출처를 확인할 수 없습니다.",
    "err.MATTER_UNAVAILABLE": "Matter 관리 기능을 사용할 수 없습니다.",
    "err.TOKEN_REQUIRED": "관리자 API 토큰이 필요합니다. 앱 설정에서 API 토큰을 지정하세요.",
    "err.TOKEN_INVALID": "유효한 관리자 API 토큰이 필요합니다.",
    "err.ADMIN_REQUIRED": "관리자 권한이 필요합니다.",
    "err.MATTER_NOT_RUNNING": "Matter 브리지가 실행 중이 아닙니다.",
    "err.NODE_NOT_STARTED": "Matter 노드가 아직 시작되지 않았습니다. 설정과 시작 로그를 확인하세요.",
    "err.INVALID_REQUEST": "잘못된 요청입니다.",
    "err.INVALID_CONFIRMATION": "확인 문구가 일치하지 않습니다.",
    "err.NOT_FOUND": "경로를 찾을 수 없습니다.",
    "err.INTERNAL": "Matter 요청을 처리하지 못했습니다.",
    "err.NOT_HAOS": "Home Assistant 애드온에서만 사용할 수 있습니다.",
    "err.BUSY": "Home Assistant 연결이 이미 진행 중입니다.",
    "err.MATTER_SERVER_NOT_INSTALLED": "Matter Server 애드온이 설치되어 있지 않습니다.",
    "err.MATTER_SERVER_STOPPED": "Matter Server 애드온이 실행 중이 아닙니다. 애드온 페이지에서 시작하세요.",
    "err.CONNECT_FAILED": "Matter Server 애드온에 연결할 수 없습니다.",
    "err.START_FAILED": "Matter Server 애드온을 시작하지 못했습니다.",
    "err.CONNECT_FAILED": "Matter Server에 연결할 수 없습니다.",
    "err.COMMISSION_FAILED": "Matter Server가 이 브리지를 추가하지 못했습니다.",
    "err.COMMISSION_TIMEOUT": "Matter Server가 제시간에 완료하지 못했습니다.",
    "err.UNKNOWN": "요청에 실패했습니다.",
    guideTitle: "다른 플랫폼 추가 방법",
    guide1: "여기서 다른 플랫폼 추가를 누르면 새 연결 창이 열립니다.",
    guide2: "다른 앱에서 기기 추가 > Matter를 선택하고 QR을 스캔하거나 수동 코드를 입력합니다.",
    guide3: "연결이 끝나면 위 목록에 플랫폼이 나타납니다. 기존 플랫폼 연결은 유지됩니다."
  }
};
// Same rule as the frontend bootstrap: stored i18nextLng first, then navigator.languages; Korean or English (default).
function pickLanguage() {
  var candidates = [];
  try { candidates.push(localStorage.getItem("i18nextLng") || ""); } catch (e) {}
  candidates = candidates.concat(navigator.languages || [navigator.language]);
  for (var i = 0; i < candidates.length; i++) {
    var base = String(candidates[i] || "").replace("_", "-").split("-")[0].toLowerCase();
    if (base === "ko" || base === "en") return base;
  }
  return "en";
}
var LANG = pickLanguage();
document.documentElement.lang = LANG;
function t(key, vars) {
  var text = I18N[LANG][key] || I18N.en[key] || key;
  for (var name in vars || {}) text = text.split("{" + name + "}").join(vars[name]);
  return text;
}
// Language-neutral confirmation word; must match the server check.
var CONFIRM_PHRASE = "REMOVE";
// Matter root vendor ids (CSA vendor registry) -> platform names. 0xFFF1 is the test vendor used by python-matter-server.
var VENDORS = {4937: "Apple Home", 24582: "Google Home", 4362: "Samsung SmartThings", 4631: "Amazon Alexa", 65521: "Home Assistant"};
var el = function (id) { return document.getElementById(id); };
document.querySelectorAll("[data-i18n]").forEach(function (node) { node.textContent = t(node.dataset.i18n); });
document.querySelectorAll("[data-i18n-label]").forEach(function (node) { node.setAttribute("aria-label", t(node.dataset.i18nLabel)); });
document.title = "Zigbee2Matter - " + t("title");
document.querySelector(".back").href = new URL("./", location.href).pathname;
var apiBase = new URL("matter-api/", location.href);
var query = new URLSearchParams(location.search);
var token = query.get("token");
if (token) {
  query.delete("token");
  var remainingQuery = query.toString();
  history.replaceState(null, "", location.pathname + (remainingQuery ? "?" + remainingQuery : "") + location.hash);
}
var headers = {"Content-Type": "application/json", "Accept-Language": LANG};
if (token) headers.Authorization = "Bearer " + token;

var windowDeadline = 0;
var windowOpen = false;
var haConnecting = false;
var pollTimer;

function errorText(e) { var key = "err." + (e.code || "UNKNOWN"); return I18N[LANG][key] ? t(key) : (e.message || t("err.UNKNOWN")); }
function showError(e) { el("error").textContent = errorText(e); }
async function call(path, options) {
  options = options || {};
  var response = await fetch(new URL(path, apiBase), Object.assign({}, options, {headers: Object.assign({}, headers, options.headers)}));
  var data = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    var error = new Error(data.error || "Request failed");
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}
function vendorName(id) { return VENDORS[id] || t("controller", {vendor: id}); }
// 11-digit manual pairing code shown as 4-3-4.
function formatCode(code) {
  var digits = String(code).replace(/[^0-9]/g, "");
  return digits.length === 11 ? digits.slice(0, 4) + "-" + digits.slice(4, 7) + "-" + digits.slice(7) : String(code);
}
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    var area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = t("copied");
  setTimeout(function () { button.textContent = t("copy"); }, 1500);
}
function renderCountdown() {
  if (!windowOpen) { el("expires").textContent = ""; return; }
  var left = Math.max(0, Math.ceil((windowDeadline - Date.now()) / 1000));
  if (left === 0) { el("expires").textContent = t("expired"); return; }
  el("expires").textContent = t("expiresIn", {time: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0")});
}
function renderWindow(win, hasFabrics) {
  windowOpen = Boolean(win);
  el("pairing").replaceChildren();
  el("pair-title").textContent = t(hasFabrics ? "pairTitleMore" : "pairTitleFirst");
  el("open").textContent = t(hasFabrics ? "pairMore" : "pairFirst");
  el("open").classList.toggle("hidden", windowOpen);
  el("close").classList.toggle("hidden", !windowOpen);
  if (!win) { renderCountdown(); return; }
  windowDeadline = Date.now() + win.expiresInMs;
  var image = document.createElement("img");
  image.className = "qr";
  image.alt = t("qrAlt");
  image.src = win.qrImage;
  var info = document.createElement("div");
  var label = document.createElement("p");
  label.textContent = t("manualCode");
  var code = document.createElement("p");
  code.className = "code";
  code.textContent = formatCode(win.setupCode);
  var copy = document.createElement("button");
  copy.className = "button secondary";
  copy.textContent = t("copy");
  copy.addEventListener("click", function () { copyText(String(win.setupCode).replace(/[^0-9]/g, "") || win.setupCode, copy); });
  info.append(label, code, copy);
  el("pairing").append(image, info);
  renderCountdown();
}
function renderHa(ha) {
  el("ha").classList.toggle("hidden", !ha.haos);
  if (!ha.haos) return;
  var running = ha.installed && ha.state === "started";
  el("ha-state").textContent = t(!ha.installed ? "haNotInstalled" : running ? "haReady" : "haStopped");
  el("ha-connect").classList.toggle("hidden", !running);
  el("ha-connect").textContent = haConnecting ? t("haConnecting") : t("haConnect");
  el("ha-connect").disabled = haConnecting;
  el("ha-install").href = ha.links.install;
  el("ha-install").classList.toggle("hidden", running);
  el("ha-integration").href = ha.links.integration;
  el("ha-integration").classList.toggle("hidden", !running);
}
function setLocked(message) {
  el("status").textContent = message;
  el("pair").classList.add("hidden");
  el("ha").classList.add("hidden");
  windowOpen = false;
}
async function refresh() {
  clearTimeout(pollTimer);
  try {
    el("error").textContent = "";
    var data = await call("state");
    el("auth").classList.add("hidden");
    if (!data.matterRunning) {
      setLocked(t("notRunning"));
      el("fabric-list").textContent = t("platformsUnavailable");
      return;
    }
    el("status").textContent = t("running");
    el("pair").classList.remove("hidden");
    var list = el("fabric-list");
    list.replaceChildren();
    if (!data.fabrics.length) list.textContent = t("noPlatforms");
    for (var i = 0; i < data.fabrics.length; i++) {
      (function (fabric) {
        var row = document.createElement("div");
        row.className = "fabric";
        var name = fabric.label || vendorName(fabric.rootVendorId);
        var label = document.createElement("span");
        label.textContent = t("platformLabel", {name: name, index: fabric.fabricIndex});
        var button = document.createElement("button");
        button.className = "button danger";
        button.textContent = t("disconnect");
        button.addEventListener("click", function () { removeFabric(fabric, name); });
        row.append(label, button);
        list.append(row);
      })(data.fabrics[i]);
    }
    renderWindow(data.window, data.fabrics.length > 0);
    if (!haConnecting) renderHa(await call("ha/status"));
  } catch (e) {
    setLocked(t(e.status === 401 || e.status === 403 ? "needAuth" : "statusFailed"));
    el("fabric-list").textContent = t("platformsFailed");
    if (e.status === 401 || e.status === 403) el("auth").classList.remove("hidden");
    showError(e);
  } finally {
    // Poll faster while a pairing window is open so a successful pairing shows up quickly.
    pollTimer = setTimeout(refresh, windowOpen ? 3000 : 10000);
  }
}
function removeFabric(fabric, name) {
  var dialog = document.createElement("dialog");
  var title = document.createElement("h2");
  title.textContent = t("dialogTitle");
  var description = document.createElement("p");
  description.className = "muted";
  description.textContent = t("dialogDescription", {platform: name});
  var label = document.createElement("label");
  label.textContent = t("confirmPrompt", {phrase: CONFIRM_PHRASE});
  var input = document.createElement("input");
  input.className = "input";
  input.autocomplete = "off";
  var actions = document.createElement("div");
  actions.className = "row";
  actions.style.marginTop = "16px";
  var cancel = document.createElement("button");
  cancel.className = "button secondary";
  cancel.textContent = t("cancel");
  var submit = document.createElement("button");
  submit.className = "button danger";
  submit.textContent = t("disconnect");
  submit.disabled = true;
  input.addEventListener("input", function () { submit.disabled = input.value !== CONFIRM_PHRASE; });
  cancel.addEventListener("click", function () { dialog.close(); });
  submit.addEventListener("click", async function () {
    try {
      await call("fabrics/" + fabric.fabricIndex, {method: "DELETE", body: JSON.stringify({confirmation: input.value})});
      dialog.close();
      await refresh();
    } catch (e) { showError(e); }
  });
  actions.append(cancel, submit);
  dialog.append(title, description, label, input, actions);
  dialog.addEventListener("close", function () { dialog.remove(); }, {once: true});
  document.body.append(dialog);
  dialog.showModal();
}
el("save-token").addEventListener("click", async function () {
  token = el("token-input").value.trim();
  if (!token) { showError({code: "TOKEN_REQUIRED"}); return; }
  headers.Authorization = "Bearer " + token;
  await refresh();
});
el("open").addEventListener("click", async function () {
  try { await call("commissioning", {method: "POST", body: JSON.stringify({})}); await refresh(); } catch (e) { showError(e); }
});
el("close").addEventListener("click", async function () {
  try { await call("commissioning", {method: "DELETE"}); await refresh(); } catch (e) { showError(e); }
});
el("ha-connect").addEventListener("click", async function () {
  haConnecting = true;
  el("ha-connect").disabled = true;
  el("ha-connect").textContent = t("haConnecting");
  el("ha-result").textContent = "";
  el("ha-result").className = "muted";
  try {
    await call("ha/connect", {method: "POST", body: "{}"});
    el("ha-result").textContent = t("haConnected");
    el("ha-result").className = "ok";
  } catch (e) {
    el("ha-result").textContent = errorText(e);
    el("ha-result").className = "error";
  }
  haConnecting = false;
  await refresh();
});
el("status").textContent = t("loading");
el("fabric-list").textContent = t("loading");
setInterval(renderCountdown, 1000);
refresh();
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
    private haConnecting = false;

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
                        if (!response.headersSent) this.writeMatterError(response, 500, "INTERNAL", "The Matter request failed.");
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

    /**
     * Requests proxied by Home Assistant ingress are already authenticated by HA: the Supervisor ingress proxy is the only
     * caller from 172.30.32.2 and always sets `X-Ingress-Path`. Direct port access must still present a token.
     */
    private isIngressRequest(request: IncomingMessage): boolean {
        return request.socket.remoteAddress?.replace(/^::ffff:/, "") === "172.30.32.2" && typeof request.headers["x-ingress-path"] === "string";
    }

    private writeMatterError(response: ServerResponse, status: number, code: string, error: string): void {
        this.writeMatterJson(response, status, {code, error});
    }

    private writeMatterServerError(response: ServerResponse, error: unknown): void {
        if (error instanceof MatterServerError) {
            this.writeMatterError(response, 502, error.code, error.message);
            return;
        }
        throw error;
    }

    private async handleMatterRequest(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
        const matter = this.getExtension?.("Matter") as Matter | undefined;
        const authorization = request.headers.authorization;
        const suppliedToken = typeof authorization === "string" ? /^Bearer +(\S+)$/i.exec(authorization)?.[1] : undefined;
        const frontendToken = settings.get().frontend.auth_token;
        const origin = request.headers.origin;
        if (request.method !== "GET" && request.headers["sec-fetch-site"] === "cross-site") {
            this.writeMatterError(response, 403, "CROSS_SITE", "Requests started from another site are not allowed.");
            return;
        }
        if (request.method !== "GET" && origin) {
            try {
                const forwardedHostHeader = request.headers["x-forwarded-host"];
                const expectedHost = (Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader)?.split(",")[0]?.trim() ?? request.headers.host;
                if (new URL(origin).host.toLowerCase() !== expectedHost?.toLowerCase()) {
                    this.writeMatterError(response, 403, "CROSS_SITE", "Requests started from another site are not allowed.");
                    return;
                }
            } catch {
                this.writeMatterError(response, 403, "ORIGIN_UNVERIFIED", "The request origin could not be verified.");
                return;
            }
        }
        if (!matter) {
            this.writeMatterError(response, 503, "MATTER_UNAVAILABLE", "Matter management is unavailable.");
            return;
        }
        if (!this.isIngressRequest(request) && !(frontendToken && suppliedToken && safeEqual(frontendToken, suppliedToken))) {
            if (!suppliedToken) {
                this.writeMatterError(response, 401, "TOKEN_REQUIRED", "An administrator API token is required. Set one in the add-on settings.");
                return;
            }
            try {
                requireScope(matter.runtime.auth.authenticate(suppliedToken), "admin");
            } catch (error) {
                const forbidden = error instanceof ApiError && error.code === "FORBIDDEN";
                this.writeMatterError(
                    response,
                    forbidden ? 403 : 401,
                    forbidden ? "ADMIN_REQUIRED" : "TOKEN_INVALID",
                    forbidden ? "Administrator permission is required." : "A valid administrator API token is required.",
                );
                return;
            }
        }
        if (!settings.get().matter.enabled || matter.degraded.has("matter")) {
            this.writeMatterError(response, 503, "MATTER_NOT_RUNNING", matter.degraded.get("matter") ?? "The Matter bridge is not running.");
            return;
        }
        const runtime = matter.runtime;
        if (!runtime.matter.currentNode) {
            this.writeMatterError(response, 503, "NODE_NOT_STARTED", "The Matter node has not started yet. Check the settings and the start-up log.");
            return;
        }

        // The page counts down locally from `expiresInMs`, so client/server clock skew does not matter.
        const withQr = async <T extends {readonly qrCode: string; readonly expiresAt: number}>(window: T) => ({
            ...window,
            expiresInMs: Math.max(0, window.expiresAt - Date.now()),
            qrImage: await QRCode.toDataURL(window.qrCode, {margin: 2, width: 256, errorCorrectionLevel: "M"}),
        });

        if (request.method === "GET" && path === "/state") {
            const window = runtime.commissioning.getActiveWindow();
            this.writeMatterJson(response, 200, {
                matterRunning: true,
                fabrics: runtime.commissioning.listFabrics().map(({fabricIndex, label, rootVendorId}) => ({fabricIndex, label, rootVendorId})),
                window: window ? await withQr(window) : undefined,
            });
            return;
        }
        if (request.method === "POST" && path === "/commissioning") {
            // Multi-admin: a window may be opened while other platforms are already connected.
            this.writeMatterJson(response, 201, await withQr(await runtime.commissioning.openWindow("frontend", 10 * 60_000)));
            return;
        }
        if (request.method === "DELETE" && path === "/commissioning") {
            this.writeMatterJson(response, 200, {closed: await runtime.commissioning.closeWindow()});
            return;
        }
        if (request.method === "GET" && path === "/ha/status") {
            try {
                this.writeMatterJson(response, 200, await getMatterServerStatus());
            } catch (error) {
                this.writeMatterServerError(response, error);
            }
            return;
        }
        if (request.method === "POST" && path === "/ha/connect") {
            if (!isHaos()) {
                this.writeMatterError(response, 404, "NOT_HAOS", "Home Assistant connection is only available in the Home Assistant add-on.");
                return;
            }
            if (this.haConnecting) {
                this.writeMatterError(response, 409, "BUSY", "A Home Assistant connection is already in progress.");
                return;
            }
            this.haConnecting = true;
            try {
                const status = await getMatterServerStatus();
                if (!status.installed) {
                    this.writeMatterError(response, 409, "MATTER_SERVER_NOT_INSTALLED", "The Matter Server add-on is not installed.");
                    return;
                }
                if (status.state !== "started") {
                    this.writeMatterError(response, 409, "MATTER_SERVER_STOPPED", "The Matter Server add-on is not running. Start it from its add-on page.");
                    return;
                }
                const window = runtime.commissioning.getActiveWindow() ?? (await runtime.commissioning.openWindow("frontend-ha", 10 * 60_000));
                // python-matter-server accepts the 11-digit manual code; strip any separators.
                await commissionIntoMatterServer(window.setupCode.replace(/\D/g, ""));
                await runtime.commissioning.closeWindow().catch(() => false);
                this.writeMatterJson(response, 200, {connected: true});
            } catch (error) {
                this.writeMatterServerError(response, error);
            } finally {
                this.haConnecting = false;
            }
            return;
        }
        const fabricPath = /^\/fabrics\/(\d+)$/.exec(path);
        if (request.method === "DELETE" && fabricPath) {
            let body: Record<string, unknown>;
            try {
                body = await this.readMatterJson(request);
            } catch {
                this.writeMatterError(response, 400, "INVALID_REQUEST", "Invalid disconnect request.");
                return;
            }
            // Language-neutral confirmation word (keep in sync with restRouter and the page).
            if (body.confirmation !== "REMOVE") {
                this.writeMatterError(response, 400, "INVALID_CONFIRMATION", 'Type "REMOVE" to remove this Matter connection.');
                return;
            }
            const removed = await runtime.commissioning.removeFabric(Number(fabricPath[1]));
            this.writeMatterJson(response, removed ? 200 : 404, {removed});
            return;
        }
        this.writeMatterError(response, 404, "NOT_FOUND", "Matter management route not found.");
    }

    private writeMatterJson(response: ServerResponse, status: number, payload: object): void {
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
