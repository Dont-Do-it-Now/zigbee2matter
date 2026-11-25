const messageCache = new Map();

const menuKeys = ["overview", "guide", "devices", "configuration", "license"];
const localeSelect = document.querySelector("#language");
const escapeHTML = (value = "") =>
    String(value).replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
function navHTML(t) {
    const activePage = location.hash.slice(1).split("/")[0];
    return `${menuKeys.map((key) => `<a href="#${key}" ${activePage === key ? 'aria-current="page"' : ""}>${t.nav[key]}</a>`).join("")}<a href="https://github.com/Dont-Do-it-Now/zigbee2matter">${t.nav.github}</a>`;
}

function sectionList(items, page, t) {
    return `<div class="docs-layout-inner"><aside class="docs-sidebar"><p class="eyebrow">${t.nav[page]}</p><nav aria-label="${t.nav[page]}">${items.map(([id, title]) => `<a href="#${page}/${id}">${title}</a>`).join("")}</nav></aside><div class="doc-sections">${items.map(([id, title, body]) => `<section id="${id}"><h2>${title}</h2>${body}</section>`).join("")}</div></div>`;
}

function renderOverview(t) {
    const home = t.home;
    return `<section class="hero home-hero"><div><div class="eyebrow">${home.eyebrow}</div><h1>${home.title}</h1><p class="lead">${home.lead}</p><p>${home.intro}</p><a class="primary-link" href="#guide">${home.start}</a></div><img class="hero-logo" src="assets/logo.png" alt=""></section>
    <section class="home-grid">${home.cards.map(([eyebrow, title, body], index) => `<a class="home-card" href="#${["guide", "devices", "configuration"][index]}"><span class="eyebrow">${eyebrow}</span><h2>${title}</h2><p>${body}</p></a>`).join("")}</section>
    <section class="overview"><div><div class="eyebrow">${t.nav.overview}</div><h2>${home.architectureTitle}</h2><p>${home.architecture}</p></div><img class="architecture" src="assets/architecture-new.png" alt="${home.architectureAlt}"></section>
    <section class="project-info" id="project"><div><div class="eyebrow">${t.nav.license}</div><h2>${home.projectTitle}</h2><p>${home.project}</p><p>${home.license}</p><a href="#license">${home.licenseLink}</a><p><a href="https://github.com/Dont-Do-it-Now/zigbee2matter">${home.source}</a></p></div></section>`;
}

function renderDocs(t, page) {
    return `<div class="docs-heading"><div class="eyebrow">${t.nav[page]}</div><h1>${t[page].title}</h1><p class="lead">${t[page].lead}</p></div>${sectionList(t[page].sections, page, t)}`;
}

function renderDevices(t) {
    return `<div class="docs-heading"><div class="eyebrow">${t.nav.devices}</div><h1>${t.devices.title}</h1><p class="lead">${t.devices.lead}</p></div><p class="note">${t.devices.note}</p><label class="search-label" for="device-search">${t.devices.search}</label><input id="device-search" type="search" autocomplete="off" placeholder="${t.devices.search}"><p id="device-status" class="muted" role="status">${t.devices.loading}</p><div id="device-results" class="device-grid"></div><p id="device-attribution" class="attribution">${t.devices.attribution.replace("{version}", "")} · <a href="https://www.zigbee2mqtt.io/supported-devices/">${t.devices.images}</a> · <a href="https://www.zigbee2mqtt.io/supported-devices/">${t.devices.upstream}</a></p>`;
}

function deviceImageUrls(device) {
    const models = [device.model, ...(device.whiteLabel || []).map((label) => label.model)].filter(Boolean);
    return [...new Set(models)].flatMap((model) => {
        const base = `https://raw.githubusercontent.com/Koenkk/zigbee2mqtt.io/master/public/images/devices/${encodeURIComponent(model)}`;
        return [`${base}.png`, `${base}.jpg`];
    });
}

function renderLicense(t) {
    const value = t.license;
    return `<div class="docs-heading"><div class="eyebrow">${t.nav.license}</div><h1>${value.title}</h1></div><section><p>${value.text}</p><p>${value.project}</p><p><a href="https://github.com/Dont-Do-it-Now/zigbee2matter/blob/main/LICENSE">${value.full}</a> · <a href="https://github.com/Koenkk/zigbee-herdsman-converters">${value.upstream}</a></p></section>`;
}

async function setupDeviceSearch(t) {
    const input = document.querySelector("#device-search");
    const output = document.querySelector("#device-results");
    const status = document.querySelector("#device-status");
    if (!input || !output || !status) return;
    let devices;
    try {
        const response = await fetch("assets/devices.json");
        if (!response.ok) throw new Error("catalogue unavailable");
        const catalog = await response.json();
        devices = catalog.devices;
        document.querySelector("#device-attribution").firstChild.textContent = t.devices.attribution.replace("{version}", catalog.version);
    } catch {
        status.textContent = t.devices.failed;
        return;
    }
    const showResults = () => {
        const query = input.value.trim().toLocaleLowerCase();
        const matches = devices.filter((device) =>
            `${device.model} ${device.vendor} ${device.description} ${(device.zigbeeModel || []).join(" ")} ${(device.whiteLabel || []).map((item) => `${item.vendor} ${item.model}`).join(" ")} ${(device.exposes || []).join(" ")}`
                .toLocaleLowerCase()
                .includes(query),
        );
        const visible = matches.slice(0, 80);
        status.textContent = query
            ? t.devices.count.replace("{count}", matches.length).replace("{shown}", visible.length)
            : t.devices.limit.replace("{count}", matches.length).replace("{shown}", visible.length);
        if (!matches.length) {
            output.innerHTML = `<p class="empty-state">${t.devices.empty}</p>`;
            return;
        }
        output.innerHTML = visible
            .map(
                (device) => {
                    const [imageUrl, ...fallbacks] = deviceImageUrls(device);
                    return `<article class="device-card"><h2>${escapeHTML(device.model)}</h2><p class="device-vendor">${escapeHTML(device.vendor || "")}</p><div class="device-image-frame"><img class="device-image" src="${escapeHTML(imageUrl)}" data-fallbacks="${escapeHTML(JSON.stringify(fallbacks))}" alt="${escapeHTML(`${device.vendor} ${device.model}`)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>${device.description ? `<p>${escapeHTML(device.description)}</p>` : ""}${device.whiteLabel?.length ? `<p class="device-meta">${escapeHTML(device.whiteLabel.map((alias) => `${alias.vendor} ${alias.model}`).join(", "))}</p>` : ""}<p class="device-meta"><strong>${t.devices.ids}:</strong> ${escapeHTML((device.zigbeeModel || []).join(", ") || "—")}</p>${device.exposes?.length ? `<p class="device-meta"><strong>${t.devices.exposes}:</strong> ${escapeHTML(device.exposes.slice(0, 12).join(", "))}</p>` : ""}</article>`;
                },
            )
            .join("");
        output.querySelectorAll(".device-image").forEach((image) => {
            image.addEventListener("error", () => {
                const [next, ...remaining] = JSON.parse(image.dataset.fallbacks || "[]");
                if (next) {
                    image.dataset.fallbacks = JSON.stringify(remaining);
                    image.src = next;
                } else {
                    image.closest(".device-image-frame")?.remove();
                }
            });
        });
    };
    input.addEventListener("input", showResults);
    showResults();
}

async function loadMessages(locale) {
    if (messageCache.has(locale)) return messageCache.get(locale);
    const response = await fetch(`assets/i18n/${locale}.json`);
    if (!response.ok) throw new Error(`Could not load ${locale} translations`);
    const messages = await response.json();
    messageCache.set(locale, messages);
    return messages;
}

let renderSequence = 0;
async function render() {
    const sequence = ++renderSequence;
    const params = new URLSearchParams(location.search);
    const storedLocale = localStorage.getItem("zigbee2matter-language");
    const locale =
        params.get("lang") === "ko" ||
        (params.get("lang") !== "en" && storedLocale === "ko") ||
        (params.get("lang") !== "en" && !storedLocale && navigator.language.toLowerCase().startsWith("ko"))
            ? "ko"
            : "en";
    let t;
    try {
        t = await loadMessages(locale);
    } catch {
        document.querySelector("#app").textContent = "Unable to load translations. Please reload the page.";
        return;
    }
    if (sequence !== renderSequence) return;
    document.documentElement.lang = locale;
    localeSelect.value = locale;
    document.querySelector("#main-nav").innerHTML = navHTML(t);
    document.querySelector("#footer-content").innerHTML =
        `${t.footer} · <a href="https://github.com/Dont-Do-it-Now/zigbee2matter/blob/main/LICENSE">${t.nav.license}</a>`;
    const [page = "overview", anchor] = location.hash.slice(1).split("/");
    const app = document.querySelector("#app");
    if (page === "overview") app.innerHTML = renderOverview(t);
    else if (page === "guide" || page === "configuration") app.innerHTML = renderDocs(t, page);
    else if (page === "devices") {
        app.innerHTML = renderDevices(t);
        void setupDeviceSearch(t);
    } else if (page === "license") app.innerHTML = renderLicense(t);
    else app.innerHTML = renderOverview(t);
    if (anchor) document.getElementById(anchor)?.scrollIntoView();
    else window.scrollTo(0, 0);
}

localeSelect.addEventListener("change", () => {
    localStorage.setItem("zigbee2matter-language", localeSelect.value);
    const url = new URL(location.href);
    url.searchParams.delete("lang");
    history.replaceState(null, "", url);
    void render();
});
window.addEventListener("hashchange", () => void render());
void render();
