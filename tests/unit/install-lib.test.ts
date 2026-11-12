/** The bridge installer: which browsers it finds and where it registers (with a fake `reg` on Windows). */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM without types
import { BROWSERS, install, locations, targetBrowsers, uninstall } from "../../bridge/install-lib.mjs";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const home = () => mkdtempSync(join(tmpdir(), "jr-install-"));

describe("finding browsers", () => {
  it("finds Chrome's channels, Vivaldi and Arc on macOS by their profile folders", () => {
    const h = home();
    for (const d of ["Google/Chrome Canary", "Vivaldi", "Arc/User Data"]) mkdirSync(join(h, "Library/Application Support", d), { recursive: true });
    expect(targetBrowsers(locations({ home: h, platform: "darwin", env: {} }))).toEqual(["chrome-canary", "vivaldi", "arc"]);
  });

  it("uses $XDG_CONFIG_HOME on Linux, and knows Arc isn't there", () => {
    const h = home();
    mkdirSync(join(h, "cfg", "google-chrome-beta"), { recursive: true });
    const loc = locations({ home: h, platform: "linux", env: { XDG_CONFIG_HOME: join(h, "cfg") } });
    expect(targetBrowsers(loc)).toEqual(["chrome-beta"]);
    expect(() => targetBrowsers(loc, "arc")).toThrow(/Unknown browser "arc"/);
  });

  it("falls back to Chrome when it finds none", () => {
    expect(targetBrowsers(locations({ home: home(), platform: "darwin", env: {} }))).toEqual(["chrome"]);
  });

  it("lists every browser it supports", () => {
    expect(BROWSERS).toEqual(["chrome", "chrome-beta", "chrome-dev", "chrome-canary", "chromium", "edge", "brave", "vivaldi", "arc"]);
  });
});

describe("Windows registry entries", () => {
  const winEnv = (h: string) => ({ LOCALAPPDATA: join(h, "AppData"), JUSTREFRESH_BRIDGE_DIR: join(h, ".justrefresh") });

  it("writes each key once: Chrome's channels share Chrome's, Vivaldi gets its own and Chrome's", () => {
    const h = home();
    for (const d of ["Google/Chrome/User Data", "Google/Chrome SxS/User Data", "Vivaldi/User Data"]) mkdirSync(join(h, "AppData", d), { recursive: true });
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => void calls.push([cmd, ...args]);
    const loc = locations({ home: h, platform: "win32", env: winEnv(h) });
    const r = install({ extensionId: ID, sourceDir: join(__dirname, "../../bridge"), node: "C:\\node.exe", loc, run, log: () => undefined });
    expect(r.browsers).toEqual(["chrome", "chrome-canary", "vivaldi"]);
    const added = calls.filter((c) => c[0] === "reg").map((c) => c[2]);
    expect(added).toEqual([
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.justrefresh.bridge",
      "HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\com.justrefresh.bridge",
    ]);
    expect(calls.some((c) => c[0] === "icacls")).toBe(true);

    calls.length = 0;
    uninstall({ loc, run, log: () => undefined });
    const deleted = calls.map((c) => c[2]);
    expect(new Set(deleted).size).toBe(deleted.length); // each key once
    expect(deleted).toContain("HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\com.justrefresh.bridge");
  });
});
