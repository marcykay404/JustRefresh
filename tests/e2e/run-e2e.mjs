// End-to-end tests: load the built extension into Chromium and exercise the
// real service worker, content script, alarms and pages.
//
//   npm run test:e2e
//
// The E2E build adds host access for 127.0.0.1 (normally granted by the user
// at runtime through optional host permissions).
import { createRequire } from "node:module";
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = resolve(import.meta.dirname, "../..");
const extDir = mkdtempSync(join(tmpdir(), "sar-ext-"));
cpSync(join(root, "dist"), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

// ---- test server ----
const loads = new Map();
let statusText = "Sold out";
let stockText = "Sold out";
let orderPosts = 0;
const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  loads.set(path, (loads.get(path) ?? 0) + 1);
  res.setHeader("content-type", "text/html");
  if (path === "/form") return res.end(`<title>Form</title><form><input id="q" value=""><button>Save</button></form>`);
  if (path === "/checkout") return res.end(`<title>Checkout</title><form method="post" action="/order"><input name="item" value="42"><button id="buy">Place order</button></form><form method="post" action="/order#done"><button id="buy-frag">Place order (#done)</button></form><form method="post" action="/order" target="_blank"><button id="buy-new-tab">Order in new tab</button></form>`);
  if (path === "/order") {
    if (req.method === "POST") orderPosts += 1;
    return res.end(`<title>Order</title><h1>Order received (${orderPosts} POSTs so far)</h1>`);
  }
  if (path === "/stock") return res.end(`<title>Stock</title><p>Item 42</p><div>${stockText}</div>`);
  if (path === "/status") return res.end(`<title>Status</title><div id="status">${statusText}</div>`);
  // A page that keeps running JS, so a debugger pause takes effect at once.
  if (path === "/stall") return res.end(`<title>Stall</title><script>setInterval(() => { window.tick = (window.tick || 0) + 1; }, 20);</script><h1>Stall</h1>`);
  res.end(`<title>Page ${path}</title><h1>Loaded ${loads.get(path)} times</h1>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const userDataDir = mkdtempSync(join(tmpdir(), "sar-profile-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extId = sw.url().split("/")[2];
await sw.evaluate(() => globalThis.__sar.ready);

const call = (method, params) => sw.evaluate(([m, p]) => globalThis.__sar.service.call({ type: "user" }, m, p), [method, params]);
const tabIdFor = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
const runtime = (tabId) => sw.evaluate((id) => globalThis.__sar.runtime.get(id), tabId);
const badge = (tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
const fireAlarm = (tabId) => sw.evaluate((id) => globalThis.__sar.engine.handleAlarm(`sar:tab:${id}`), tabId);
const waitFor = async (fn, what, timeout = 10_000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, "ok"]);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push([name, e]);
    console.log(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ")}`);
  }
}

console.log(`Extension ${extId} loaded; server ${base}`);

await test("per-tab refresh: alarm reloads the tab and navigation completion is tracked", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/basic`);
  const tabId = await tabIdFor(`${base}/basic`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await waitFor(async () => (await badge(tabId)) === "ON", "toolbar badge ON");
  const alarm = await sw.evaluate((id) => chrome.alarms.get(`sar:tab:${id}`), tabId);
  assert.ok(alarm && alarm.scheduledTime > Date.now() + 25_000, "alarm scheduled ~30s out");
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.navigationCount === 1, "navigation count");
  assert.equal(loads.get("/basic"), 2);
  const rt = await runtime(tabId);
  assert.equal(rt.status, "scheduled");
  assert.equal(rt.refreshCount, 1);
  await page.close();
});

await test("fast intervals (opt-in): a 5 s tab refreshes on real time, below Chrome's 30 s alarm minimum", async () => {
  await call("updateSettings", { allowFastIntervals: true });
  const page = await context.newPage();
  await page.goto(`${base}/fast`);
  const tabId = await tabIdFor(`${base}/fast`);
  await call("startTab", { tabId, intervalSeconds: 5 });
  // No manual alarm firing: the service-worker short timer drives it.
  await waitFor(() => (loads.get("/fast") ?? 0) >= 3, "two timed reloads within ~13 s", 13_000);
  await call("stopTab", { tabId });
  await call("updateSettings", { allowFastIntervals: false });
  await page.close();
});

await test("typing protection postpones refresh; unsaved form blocks manual refresh", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/form`);
  const tabId = await tabIdFor(`${base}/form`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await page.waitForTimeout(300);
  await page.locator("#q").pressSequentially("draft text");
  await fireAlarm(tabId);
  const rt = await runtime(tabId);
  assert.match(rt.status, /paused_(activity|unsaved)/);
  assert.equal(loads.get("/form"), 1, "not reloaded");
  const manual = await call("refreshNow", { tabId });
  assert.equal(manual.refreshed, false);
  assert.match(manual.reason, /unsaved/);
  // Typed text never leaves the page:
  const history = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  assert.ok(!history.includes("draft text"));
  await page.close();
});

await test("a page paused in the debugger does not wedge its tab or the API", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/stall`);
  const tabId = await tabIdFor(`${base}/stall`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await page.waitForTimeout(300);

  // Pause the page's main thread like a DevTools breakpoint would.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Debugger.enable");
  const paused = new Promise((r) => cdp.once("Debugger.paused", r));
  await cdp.send("Debugger.pause");
  await paused;

  // The cycle must finish (bounded waits) instead of hanging in "evaluating".
  const cycle = fireAlarm(tabId);
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("cycle still running after 40s")), 40_000));
  // Meanwhile an API call touching the tab must not be blocked indefinitely.
  const status = await Promise.race([call("listTabs"), deadline]);
  assert.ok(Array.isArray(status));
  await Promise.race([cycle, deadline]);
  let rt = await runtime(tabId);
  assert.equal(rt.status, "paused_activity", `status ${rt.status}: ${rt.reason}`);
  assert.equal(loads.get("/stall"), 1, "not reloaded while unresponsive");

  // Resumed page: the next cycle refreshes normally.
  await cdp.send("Debugger.resume");
  await cdp.detach();
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.navigationCount === 1, "navigation after resume");
  assert.equal(loads.get("/stall"), 2);
  await page.close();
});

await test("refresh until condition: stops and records completion when #status says Available", async () => {
  statusText = "Sold out";
  await call("createRule", {
    rule: {
      id: "e2e-status",
      name: "Wait for availability",
      target: { patterns: [`${base}/status`] },
      trigger: { type: "interval", seconds: 30 },
      stopWhen: { type: "dom.text", selector: "#status", operator: "contains", value: "Available" },
      actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify", title: "Available", sound: true }] },
    },
  });
  const page = await context.newPage();
  await page.goto(`${base}/status`);
  const tabId = await tabIdFor(`${base}/status`);
  await waitFor(async () => (await runtime(tabId))?.controllerId === "e2e-status", "rule applied to new tab");

  const dry = await call("testRule", { rule: await call("getRule", { id: "e2e-status" }), tabId });
  assert.equal(dry.result.status, "not_matched");

  statusText = "Now Available";
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "completed", "completed status");
  await waitFor(async () => (await badge(tabId)) === "✓", "toolbar badge ✓");
  // The alert sound plays from an offscreen document (service workers cannot play audio).
  await waitFor(
    async () => (await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))).length === 1,
    "offscreen audio document",
  );
  const rt = await runtime(tabId);
  assert.equal(rt.lastEvaluation.status, "matched");
  assert.equal(loads.get("/status"), 2);
  await fireAlarm(tabId);
  assert.equal(loads.get("/status"), 2, "no refresh after completion");
  await page.close();
});

await test("exclusions override rules", async () => {
  await call("createRule", { rule: { id: "e2e-all", name: "All local", target: { patterns: [`${base}/*`] }, trigger: { type: "interval", seconds: 30 }, priority: -1 } });
  await call("addExclusion", { pattern: `${base}/checkout/*` });
  const page = await context.newPage();
  await page.goto(`${base}/checkout/pay`);
  const tabId = await tabIdFor(`${base}/checkout/pay`);
  await waitFor(async () => (await runtime(tabId))?.status === "excluded", "excluded");
  await fireAlarm(tabId);
  assert.equal(loads.get("/checkout/pay"), 1);
  await page.close();
});

await test("service worker restart: no lost or duplicate alarms", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/restart`);
  const tabId = await tabIdFor(`${base}/restart`);
  await call("startTab", { tabId, intervalSeconds: 60 });
  const before = await sw.evaluate(() => chrome.alarms.getAll());
  // Terminate the worker via CDP and let Chrome restart it.
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable").catch(() => undefined);
  await cdp.send("ServiceWorker.stopAllWorkers").catch(() => undefined);
  await page.waitForTimeout(500);
  sw = context.serviceWorkers()[0] ?? (await Promise.race([context.waitForEvent("serviceworker"), page.reload().then(() => context.waitForEvent("serviceworker"))]));
  await sw.evaluate(() => globalThis.__sar.ready);
  const after = await sw.evaluate(() => chrome.alarms.getAll());
  const names = after.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, "no duplicate alarms");
  assert.ok(names.includes(`sar:tab:${tabId}`));
  assert.equal(after.length, before.length);
  await page.close();
});

/** The real popup, pointed at `tabId` (a popup opened as a page would otherwise see itself as the active tab). */
async function openPopupFor(tabId, file) {
  const popup = await context.newPage();
  await popup.addInitScript((id) => {
    chrome.tabs.query = async () => [{ id }];
  }, tabId);
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByText("JustRefresh").first().waitFor();
  return popup;
}

await test("popup: start a timer with one tap, then 'Refresh until' hands the tab to a new rule that stops when the text appears", async () => {
  stockText = "Sold out";
  // Earlier tests leave rules covering every local page; switch them off so this tab starts uncontrolled.
  const others = (await call("listRules")).filter((r) => r.enabled);
  for (const r of others) await call("disableRule", { id: r.id });
  const page = await context.newPage();
  await page.goto(`${base}/stock`);
  const tabId = await tabIdFor(`${base}/stock`);

  let popup = await openPopupFor(tabId);
  await popup.getByRole("button", { name: "1 min", exact: true }).click();
  await popup.getByRole("button", { name: "Start refreshing every 1 min" }).click();
  await waitFor(async () => (await runtime(tabId))?.status === "scheduled", "tab timer scheduled");
  assert.equal((await runtime(tabId)).controllerId, `tab:${tabId}`);
  await popup.getByText("Next refresh in").waitFor();
  await popup.getByText(/Protected: waits while you're typing/).waitFor();
  await popup.screenshot({ path: join(root, "test-results", "popup-running.png") });

  await popup.getByRole("button", { name: /More/ }).click();
  await popup.getByRole("button", { name: /Refresh until something appears/ }).click();
  await popup.getByLabel("Text to look for").fill("In stock");
  await popup.getByRole("button", { name: "30 sec", exact: true }).click();
  await popup.screenshot({ path: join(root, "test-results", "popup-until.png") });
  await popup.getByRole("button", { name: "Start watching" }).click();

  // The tab is now run by the new rule, which checked the page straight away.
  const rule = await waitFor(async () => (await call("listRules")).find((r) => r.name.includes("“In stock”")), "rule created");
  assert.deepEqual(rule.target.patterns, [{ type: "exact", value: `${base}/stock` }]);
  await waitFor(async () => (await runtime(tabId))?.controllerId === rule.id, "rule took over the tab");
  await waitFor(async () => (await runtime(tabId))?.lastEvaluation?.status === "not_matched", "first check: not found yet");
  await popup.close();
  popup = await openPopupFor(tabId);
  await popup.getByText("Refreshing every 30 sec until “In stock” appears, then notify me").waitFor();
  await popup.screenshot({ path: join(root, "test-results", "popup-rule.png") });
  await popup.close();

  stockText = "Back In Stock";
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "completed", "completed when the text appears");
  await call("deleteRule", { id: rule.id, expectedRevision: rule.meta.revision });
  for (const r of others) await call("enableRule", { id: r.id });
  await page.close();
});

await test("first install opens the welcome page once; a template creates a working rule", async () => {
  const welcome = await waitFor(() => context.pages().find((p) => p.url().endsWith("dashboard.html#/welcome")), "welcome tab after install");
  await welcome.setViewportSize({ width: 1280, height: 900 });
  await welcome.getByRole("heading", { name: "Welcome to JustRefresh" }).waitFor();
  await welcome.screenshot({ path: join(root, "test-results", "welcome.png") });
  await welcome.getByRole("link", { name: "Browse templates" }).click();
  await welcome.getByRole("heading", { name: "Templates", exact: true }).waitFor();
  await welcome.screenshot({ path: join(root, "test-results", "templates.png") });

  const others = (await call("listRules")).filter((r) => r.enabled);
  for (const r of others) await call("disableRule", { id: r.id });
  stockText = "Sold out";
  const shop = await context.newPage();
  await shop.goto(`${base}/stock`);
  const tabId = await tabIdFor(`${base}/stock`);

  await welcome.reload();
  await welcome.locator("article", { hasText: "back in stock" }).getByRole("button", { name: "Use template" }).click();
  const form = welcome.getByRole("dialog");
  const option = await form.locator("option", { hasText: "/stock" }).getAttribute("value");
  await form.getByLabel("Which page?").selectOption(option);
  await form.getByText(`Refresh 127.0.0.1:${new URL(base).port}/stock every 1 min until “In stock” appears`).waitFor();
  await welcome.screenshot({ path: join(root, "test-results", "template-form.png") });
  await form.getByRole("button", { name: "Create and start" }).click();
  await welcome.getByText(/Created “Back in stock/).waitFor();

  const rule = (await call("listRules")).find((r) => r.name.startsWith("Back in stock"));
  assert.ok(rule, "rule created");
  await waitFor(async () => (await runtime(tabId))?.controllerId === rule.id, "template rule runs on the tab");
  await waitFor(async () => (await runtime(tabId))?.lastEvaluation?.status === "not_matched", "checked at once");
  stockText = "In stock now";
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "completed", "completes when the text appears");

  await call("deleteRule", { id: rule.id, expectedRevision: rule.meta.revision });
  for (const r of others) await call("enableRule", { id: r.id });
  await shop.close();
  await welcome.close();
});

await test("a page reached by submitting a form is never reloaded; Open this page fresh loads it with GET", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/checkout`);
  await Promise.all([page.waitForURL(`${base}/order`), page.click("#buy")]);
  assert.equal(orderPosts, 1);
  const tabId = await tabIdFor(`${base}/order`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "paused_resubmit", "paused on the form result");
  assert.equal(await sw.evaluate((id) => chrome.alarms.get(`sar:tab:${id}`), tabId), undefined, "no timer while paused on the form page");
  const refresh = await call("refreshNow", { tabId });
  assert.equal(refresh.formResult, true);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(orderPosts, 1, "the order was not sent again");

  await call("openFresh", { tabId });
  await page.waitForLoadState("load");
  await waitFor(async () => (await runtime(tabId))?.status === "scheduled", "refreshing resumes after opening fresh");
  assert.equal(orderPosts, 1, "opening fresh does not resend");
  const before = loads.get("/order") ?? 0;
  await fireAlarm(tabId);
  await waitFor(async () => (loads.get("/order") ?? 0) > before, "the fresh page refreshes normally");
  assert.equal(orderPosts, 1);
  await call("stopTab", { tabId });
  await page.close();
});

await test("form pages: a #fragment result can be opened fresh, and a form that opened elsewhere doesn't block the next page", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/checkout`);
  const posts = orderPosts;
  await Promise.all([page.waitForURL(`${base}/order#done`), page.click("#buy-frag")]);
  const tabId = await tabIdFor(`${base}/order#done`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "paused_resubmit", "paused on the #fragment form result");
  const gets = loads.get("/order") ?? 0;
  await call("openFresh", { tabId });
  await waitFor(async () => (loads.get("/order") ?? 0) > gets, "opening fresh fetched the page again (not an in-page jump)");
  assert.equal(orderPosts, posts + 1, "only the original order was sent");
  await call("stopTab", { tabId });

  // A form whose result opens in another tab: this tab's next page is ordinary.
  await page.goto(`${base}/checkout`);
  const [popupTab] = await Promise.all([context.waitForEvent("page"), page.click("#buy-new-tab")]);
  await popupTab.close();
  await page.goto(`${base}/order`); // a plain GET visit to the same address
  const tab2 = await tabIdFor(`${base}/order`);
  await call("startTab", { tabId: tab2, intervalSeconds: 30 });
  const before = loads.get("/order") ?? 0;
  await fireAlarm(tab2);
  await waitFor(async () => (loads.get("/order") ?? 0) > before, "refreshed normally");
  assert.notEqual((await runtime(tab2))?.status, "paused_resubmit");
  await call("stopTab", { tabId: tab2 });
  await page.close();
});

await test("a tab paused on a form page resumes by itself when you go to another page", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/checkout`);
  await Promise.all([page.waitForURL(`${base}/order`), page.click("#buy")]);
  const tabId = await tabIdFor(`${base}/order`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "paused_resubmit", "paused on the form result");
  await page.goto(`${base}/stock`);
  await waitFor(async () => (await runtime(tabId))?.status === "scheduled", "resumed after going to another page");
  assert.ok(await sw.evaluate((id) => chrome.alarms.get(`sar:tab:${id}`), tabId), "timer set again");
  await call("stopTab", { tabId });
  await page.close();
});

await test("a #hash or replaceState change on a paused form page keeps the run (same time limit, still paused)", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/checkout`);
  await Promise.all([page.waitForURL(`${base}/order`), page.click("#buy")]);
  const posts = orderPosts;
  const tabId = await tabIdFor(`${base}/order`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "paused_resubmit", "paused on the form result");
  const before = await runtime(tabId);
  await page.evaluate(() => { location.hash = "receipt"; });
  await page.evaluate(() => history.replaceState({}, "", "/order/42"));
  await waitFor(async () => (await sw.evaluate((id) => chrome.tabs.get(id), tabId)).url.endsWith("/order/42"), "address changed");
  await new Promise((r) => setTimeout(r, 500));
  await fireAlarm(tabId);
  await new Promise((r) => setTimeout(r, 1000));
  const after = await runtime(tabId);
  assert.equal(after?.status, "paused_resubmit");
  assert.equal(after?.generation, before.generation, "same run");
  assert.equal(after?.startedAt, before.startedAt, "time limit didn't start over");
  assert.equal(orderPosts, posts, "the form was not sent again");
  await call("stopTab", { tabId });
  await page.close();
});

await test("a form page unloaded by Memory Saver and restored is still never reloaded", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/checkout`);
  await Promise.all([page.waitForURL(`${base}/order`), page.click("#buy")]);
  const posts = orderPosts;
  const tabId = await tabIdFor(`${base}/order`);
  await call("startTab", { tabId, intervalSeconds: 30 });
  await fireAlarm(tabId);
  await waitFor(async () => (await runtime(tabId))?.status === "paused_resubmit", "paused on the form result");
  const other = await context.newPage();
  await other.goto(`${base}/x`);
  const discarded = await sw.evaluate(async (id) => (await chrome.tabs.discard(id))?.id ?? id, tabId);
  await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), discarded);
  await waitFor(async () => (await sw.evaluate((id) => chrome.tabs.get(id), discarded)).status === "complete", "restored");
  await new Promise((r) => setTimeout(r, 500));
  await fireAlarm(discarded);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(orderPosts, posts, "the form was not sent again after the restore");
  assert.equal((await runtime(discarded))?.status, "paused_resubmit");
  await call("stopTab", { tabId: discarded });
  await other.close();
});

await test("the dashboard updates on changes without polling the service worker", async () => {
  // Nothing else may refresh meanwhile (an "all local pages" rule would).
  const others = (await call("listRules")).filter((r) => r.enabled);
  for (const r of others) await call("disableRule", { id: r.id });
  const dash = await context.newPage();
  // Count the dashboard's API calls (each one wakes the service worker).
  await dash.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__apiCalls = 0;
    chrome.runtime.sendMessage = (...a) => ((window.__apiCalls += 1), send(...a));
  });
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/tabs`);
  await dash.getByRole("heading", { name: "Tabs" }).waitFor();
  await new Promise((r) => setTimeout(r, 1000));
  const settled = await dash.evaluate(() => window.__apiCalls);
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(await dash.evaluate(() => window.__apiCalls), settled, "no API calls while nothing changes");

  // A new tab appears, and starting it shows up, both within a moment.
  const page = await context.newPage();
  await page.goto(`${base}/live-check`);
  const row = dash.locator("tr", { hasText: `${base}/live-check` });
  await row.waitFor({ timeout: 3000 });
  const tabId = await tabIdFor(`${base}/live-check`);
  await call("startTab", { tabId, intervalSeconds: 600 });
  await row.getByText("Scheduled", { exact: true }).waitFor({ timeout: 3000 });
  // A change to the tab's run state alone (storage.session, no config or tab event).
  await sw.evaluate(async (id) => {
    const rt = await globalThis.__sar.runtime.get(id);
    await globalThis.__sar.runtime.put({ ...rt, refreshCount: 42 });
  }, tabId);
  await row.getByText("42", { exact: true }).waitFor({ timeout: 3000 });
  await call("stopTab", { tabId });
  await row.getByText("Stopped", { exact: true }).waitFor({ timeout: 3000 });
  await page.close();
  await dash.close();
  for (const r of others) await call("enableRule", { id: r.id });
});

await test("popup and dashboard render", async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extId}/dashboard.html#/rules`);
  await page.getByText("Wait for availability").waitFor();
  await page.goto(`chrome-extension://${extId}/dashboard.html#/builder/e2e-status`);
  await page.getByText("Edit rule: Wait for availability").waitFor();
  await page.getByText("Valid", { exact: true }).waitFor();
  await page.screenshot({ path: join(root, "test-results", "builder.png"), fullPage: true });
  await page.goto(`chrome-extension://${extId}/dashboard.html#/tabs`);
  await page.getByRole("heading", { name: "Tabs" }).waitFor();
  await page.screenshot({ path: join(root, "test-results", "tabs.png") });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByText("JustRefresh").first().waitFor();
  await popup.screenshot({ path: join(root, "test-results", "popup.png") });
  await popup.close();
  await page.close();
});

await context.close();
server.close();
rmSync(extDir, { recursive: true, force: true });
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter(([, r]) => r !== "ok");
console.log(`\n${results.length - failed.length}/${results.length} e2e tests passed`);
process.exit(failed.length ? 1 : 0);
