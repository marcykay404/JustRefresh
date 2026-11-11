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
const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  loads.set(path, (loads.get(path) ?? 0) + 1);
  res.setHeader("content-type", "text/html");
  if (path === "/form") return res.end(`<title>Form</title><form><input id="q" value=""><button>Save</button></form>`);
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
