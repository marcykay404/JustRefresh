// Chrome Web Store images, from the real built extension (run `npm run build` first):
//
//   npm run store:assets   → store/screenshot-1..5.jpg (1280×800) and store/promo-small.png (440×280)
//
// (The store icon, store/icon-128.png, comes from scripts/make-icons.mjs with the other icons.)
//
// Each screenshot is the real popup or dashboard over a fictional site ("Lumen Hall", served
// locally), with a short caption. Laid out at 640×400 and rendered at 2× so it stays readable at
// the 640×400 the store shows today. Re-run after UI changes.
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = resolve(import.meta.dirname, "..");
const out = join(root, "store");
const rawDir = join(out, "raw");
mkdirSync(rawDir, { recursive: true });

/* ---------------- the fictional site ---------------- */
let ticketState = "Sold out";
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; font: 15px/1.5 Georgia, "Times New Roman", serif; background: #faf7f2; color: #2b2622; }
  header { background: #2b2622; color: #f3e9dc; padding: 14px 28px; font: 600 18px/1 system-ui, sans-serif; letter-spacing: .04em; }
  main { max-width: 720px; margin: 28px auto; padding: 0 28px; }
  h1 { font-size: 30px; margin: 0 0 6px; } .muted { color: #7a7067; }
  .status { display: inline-block; margin: 14px 0; padding: 8px 14px; border-radius: 6px; font: 600 15px system-ui, sans-serif; }
  .sold { background: #efe6da; color: #7a5a3a; } .ok { background: #d9f2df; color: #1e6b37; }
  .row { display: flex; gap: 16px; margin-top: 10px } .seat { flex: 1; background: #fff; border: 1px solid #e6ddd0; border-radius: 8px; padding: 12px; font-family: system-ui, sans-serif; font-size: 14px }
  label { display: block; font: 600 13px system-ui, sans-serif; margin: 14px 0 4px }
  input, textarea { width: 100%; box-sizing: border-box; font: 15px system-ui, sans-serif; padding: 8px; border: 1px solid #d6cbbd; border-radius: 6px; background: #fff }
</style>
<header>LUMEN HALL</header><main>${body}</main>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/tickets")
    return res.end(
      page(
        "Aurora Quartet · Lumen Hall",
        `<p class="muted">Saturday 14 March · 8 pm</p><h1>Aurora Quartet</h1><p>Strings by candlelight: Haydn, Ravel and new works.</p>
         <div id="status" class="status ${ticketState === "Sold out" ? "sold" : "ok"}">${ticketState}</div>
         <div class="row"><div class="seat">Stalls<br><b>£28</b></div><div class="seat">Circle<br><b>£22</b></div><div class="seat">Balcony<br><b>£16</b></div></div>`,
      ),
    );
  if (path === "/contact")
    return res.end(
      page(
        "Contact us · Lumen Hall",
        `<h1>Write to the box office</h1><p class="muted">We usually answer within a day.</p>
         <label for="name">Your name</label><input id="name"><label for="msg">Message</label><textarea id="msg" rows="6"></textarea>`,
      ),
    );
  if (path === "/listings")
    return res.end(
      page(
        "What's on · Lumen Hall",
        `<h1>What's on</h1><p class="muted">Spring season</p><div class="row"><div class="seat">Aurora Quartet</div><div class="seat">Night Trains</div><div class="seat">Folk at Noon</div></div>`,
      ),
    );
  res.end(page("Lumen Hall", "<h1>Lumen Hall</h1>"));
});
// Only the fictional site is served; anything over HTTPS (CONNECT) is refused at once instead of hanging.
server.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// The browser reaches the site through this server as a proxy, so pages show a real-looking
// address. ".example" is reserved: it can never be someone's site.
const HOST = "lumenhall.example";
const base = `http://${HOST}`;

/* ---------------- the extension ---------------- */
const extDir = mkdtempSync(join(tmpdir(), "justrefresh-store-ext-"));
cpSync(join(root, "dist"), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions = [`http://${HOST}/*`]; // granted up front, like site access the user allowed
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

const profileDir = mkdtempSync(join(tmpdir(), "justrefresh-store-profile-"));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: true,
  colorScheme: "light",
  proxy: { server: `http://127.0.0.1:${server.address().port}` },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
// Drives the extension through its debug hook (service-worker.ts, globalThis.__justrefresh), as the e2e tests do.
if (!(await sw.evaluate(() => !!globalThis.__justrefresh))) throw new Error("The built extension has no __justrefresh hook; this script needs it");
const extId = sw.url().split("/")[2];
await sw.evaluate(() => globalThis.__justrefresh.ready);
for (const p of context.pages()) if (p.url().includes("welcome")) await p.close();
const call = (method, params) => sw.evaluate(([m, p]) => globalThis.__justrefresh.service.call({ type: "user" }, m, p), [method, params]);
const callAs = (agentId, method, params) =>
  sw.evaluate(([id, m, p]) => globalThis.__justrefresh.service.call({ type: "agent", agentId: id }, m, p), [agentId, method, params]);
const tabIdFor = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
const fireAlarm = (tabId) => sw.evaluate((id) => globalThis.__justrefresh.engine.handleAlarm(`justrefresh:tab:${id}`), tabId);

async function site(path, viewport = { width: 900, height: 620 }) {
  const p = await context.newPage();
  await p.setViewportSize(viewport);
  await p.goto(`${base}${path}`);
  return { page: p, tabId: await tabIdFor(`${base}${path}`) };
}

/** The real popup, pointed at `tabId`, cropped to its content. */
async function popupShot(tabId, name, act = async () => undefined) {
  const popup = await context.newPage();
  await popup.addInitScript((id) => {
    chrome.tabs.query = async () => [{ id }];
  }, tabId);
  await popup.setViewportSize({ width: 380, height: 700 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByText("JustRefresh").first().waitFor();
  await act(popup);
  await popup.waitForTimeout(400);
  const box = await popup.locator(".popup-root").boundingBox();
  await popup.screenshot({ path: join(rawDir, `${name}.png`), clip: { x: 0, y: 0, width: 380, height: Math.ceil(box.y + box.height + 8) } });
  await popup.close();
}

async function pageShot(p, name) {
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(rawDir, `${name}.png`) });
}

/* 1. One tap: refresh a tab on a timer, protected while you type. */
{
  const { page: p, tabId } = await site("/listings");
  await call("startTab", { tabId, intervalSeconds: 300 });
  await pageShot(p, "s1-page");
  await popupShot(tabId, "s1-popup", (popup) => popup.getByText("Next refresh in").waitFor());
}

/* 2. Refresh until something appears, then tell me. */
{
  const { page: p, tabId } = await site("/tickets");
  await pageShot(p, "s2-page");
  await popupShot(tabId, "s2-popup", async (popup) => {
    await popup.getByText("More", { exact: true }).click();
    await popup.getByText(/Refresh until something appears/).click();
    await popup.locator("input").first().fill("Tickets available");
  });
}

/* 3. Waits while you're typing. */
{
  const { page: p, tabId } = await site("/contact");
  await call("startTab", { tabId, intervalSeconds: 60 });
  await p.waitForTimeout(300);
  await p.locator("#name").fill("Sam Rivera");
  await p.locator("#msg").pressSequentially("Hello! Could you hold two Circle seats for the Aurora Quartet on the 14th? I'll pay at the door", { delay: 5 });
  await fireAlarm(tabId);
  await pageShot(p, "s3-page");
  await popupShot(tabId, "s3-popup");
}

/* 4. Start from a template. 5. An AI app asks; you approve. */
{
  const dash = await context.newPage();
  await dash.setViewportSize({ width: 1100, height: 720 });
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/templates`);
  await dash.getByText("Tell me when it's back in stock").first().waitFor();
  await pageShot(dash, "s4-dashboard");

  const agentId = "native:ai-assistant";
  await sw.evaluate((id) => globalThis.__justrefresh.service.ensureAgent({ id, name: "AI assistant (MCP)", transport: "native" }), agentId);
  await call("updateAgent", {
    id: agentId,
    status: "approved",
    scopes: ["tabs:read", "rules:read", "rules:write", "rules:test", "rules:activate", "status:read"],
  });
  const created = await callAs(agentId, "createRule", {
    rule: {
      name: "Aurora Quartet: tell me when tickets are back",
      target: { patterns: [`${base}/tickets`] },
      trigger: { type: "interval", seconds: 300 },
      stopWhen: { type: "dom.text", selector: "#status", operator: "contains", value: "Tickets available" },
      actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify", title: "Tickets are back" }], onNotMatched: [{ type: "refresh" }] },
      limits: { maxDurationSeconds: 86400 },
    },
  });
  await callAs(agentId, "enableRule", { id: created.id });
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/agents`);
  await dash.getByText("Aurora Quartet: tell me when tickets are back").first().waitFor();
  await pageShot(dash, "s5-dashboard");
}

/* ---------------- compose: caption on the left, a browser window on the right ---------------- */
const img = (file) => `data:image/png;base64,${readFileSync(join(rawDir, file)).toString("base64")}`;
const toolbarIcon = `data:image/png;base64,${readFileSync(join(root, "public", "icons", "icon32.png")).toString("base64")}`;

const SCENES = [
  {
    title: "Refresh any tab in one tap",
    text: "Pick an interval and press Start. Pause, stop or refresh now from the same place.",
    address: `${HOST}/listings`,
    page: "s1-page.png",
    popup: "s1-popup.png",
  },
  {
    title: "Refresh until something appears",
    text: "Say what you're waiting for. JustRefresh stops, notifies you and highlights it.",
    address: `${HOST}/tickets`,
    page: "s2-page.png",
    popup: "s2-popup.png",
  },
  {
    title: "Waits while you're typing",
    text: "A form you've started isn't refreshed away: it waits until you're done.",
    address: `${HOST}/contact`,
    page: "s3-page.png",
    popup: "s3-popup.png",
  },
  {
    title: "Start from a template",
    text: "Back in stock, status changes, a work-hours dashboard, failed builds, and your own rules.",
    address: "JustRefresh · Dashboard",
    dashboard: "s4-dashboard.png",
    // Down to the end of the second row of templates, so no card is cut off.
    height: 560,
  },
  {
    title: "Your AI app proposes, you approve",
    text: "AI apps on this computer can set up rules over MCP. Their rules stay off until you approve them.",
    address: "JustRefresh · Dashboard",
    dashboard: "s5-dashboard.png",
  },
];

function sceneHtml(s) {
  // The dashboard without its sidebar, so the content is shown larger.
  const content = s.dashboard
    ? `<div class="dash" style="background-image:url(${img(s.dashboard)}); height: ${s.height ?? 708}px"></div>`
    : `<img class="site" src="${img(s.page)}"><img class="popup" src="${img(s.popup)}">`;
  return `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0 }
    body { width: 1280px; height: 800px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 55%, #3b82f6 100%); color: #fff; position: relative }
    .caption { position: absolute; left: 56px; top: 0; bottom: 0; width: 340px; display: flex; flex-direction: column; justify-content: center; gap: 18px }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 20px; opacity: .92 }
    .brand img { width: 32px; height: 32px; border-radius: 7px; box-shadow: 0 0 0 2px rgba(255,255,255,.35) }
    h1 { font-size: 44px; line-height: 1.1; font-weight: 750; letter-spacing: -.01em }
    p { font-size: 22px; line-height: 1.4; color: rgba(255,255,255,.88); text-wrap: pretty }
    .window { position: absolute; left: 420px; top: 56px; width: 820px; height: 688px; border-radius: 12px; overflow: hidden;
      background: ${s.dashboard ? "#f7f8fa" : "#faf7f2"}; box-shadow: 0 24px 60px rgba(10, 25, 80, .45) }
    .bar { height: 44px; background: #e8ebf0; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid #d5dae2 }
    .dots { display: flex; gap: 7px } .dots i { width: 12px; height: 12px; border-radius: 50%; background: #c6ccd6; display: block }
    .address { flex: 1; height: 28px; border-radius: 14px; background: #fff; color: #444b55; font-size: 14px; display: flex; align-items: center; padding: 0 14px }
    .ext { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: ${s.dashboard ? "transparent" : "#d4dcf0"} }
    .ext img { width: 18px; height: 18px }
    .site { position: absolute; left: 0; top: 44px; width: 820px }
    .popup { position: absolute; right: 12px; top: 50px; width: 380px; border-radius: 10px; box-shadow: 0 12px 36px rgba(20, 30, 60, .35), 0 0 0 1px rgba(0,0,0,.08) }
    .dash { position: absolute; left: 0; top: 44px; right: 0; bottom: 0; background-color: #f7f8fa; background-repeat: no-repeat;
      background-size: 1100px 720px; background-position: -200px 0; transform-origin: 0 0; transform: scale(${820 / 900}); width: 900px; height: 708px }
  </style>
  <div class="caption"><div class="brand"><img src="${toolbarIcon}">JustRefresh</div><h1>${s.title}</h1><p>${s.text}</p></div>
  <div class="window"><div class="bar"><div class="dots"><i></i><i></i><i></i></div><div class="address">${s.address}</div>
    <div class="ext"><img src="${toolbarIcon}"></div></div>${content}</div>`;
}

{
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });
  for (const [i, s] of SCENES.entries()) {
    await canvas.setContent(sceneHtml(s));
    await canvas.waitForTimeout(150);
    // JPEG: no alpha channel, as the store expects.
    await canvas.screenshot({ path: join(out, `screenshot-${i + 1}.jpg`), type: "jpeg", quality: 92 });
  }
  // Small promo tile (440×280): the brand, no text (promo images aren't translated), saturated, still clear at half size.
  const icon = `data:image/png;base64,${readFileSync(join(root, "public", "icons", "icon128.png")).toString("base64")}`;
  await canvas.setViewportSize({ width: 440, height: 280 });
  await canvas.setContent(`<!doctype html><style>
    * { margin: 0 } body { width: 440px; height: 280px; overflow: hidden; position: relative;
      background: radial-gradient(circle at 30% 20%, #3b82f6 0%, #2563eb 45%, #1e3a8a 100%) }
    .tab { position: absolute; width: 150px; height: 104px; border-radius: 14px; background: rgba(255,255,255,.14); border: 2px solid rgba(255,255,255,.28) }
    .tab::before { content: ""; position: absolute; left: 12px; right: 12px; top: 14px; height: 10px; border-radius: 5px; background: rgba(255,255,255,.35) }
    .tab::after { content: ""; position: absolute; left: 12px; width: 60%; top: 34px; height: 8px; border-radius: 4px; background: rgba(255,255,255,.22) }
    .t1 { left: 34px; top: 58px; transform: rotate(-8deg) } .t2 { right: 34px; top: 118px; transform: rotate(7deg) }
    .icon { position: absolute; left: 50%; top: 50%; width: 132px; height: 132px; transform: translate(-50%, -50%);
      border-radius: 34px; box-shadow: 0 16px 40px rgba(8, 20, 70, .55), 0 0 0 6px rgba(255,255,255,.9) }
  </style><div class="tab t1"></div><div class="tab t2"></div><img class="icon" src="${icon}">`);
  await canvas.waitForTimeout(150);
  await canvas.screenshot({ path: join(out, "promo-small.png") });
  await canvas.close();
}

console.log(`Store images in ${out} (extension ${extId})`);
await context.close();
server.close();
for (const dir of [extDir, profileDir]) rmSync(dir, { recursive: true, force: true });
