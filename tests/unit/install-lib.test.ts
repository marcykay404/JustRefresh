/** The bridge installer: which browsers it finds and where it registers (with a fake `reg` on Windows). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM without types
import { BROWSERS, install, locations, parseInstallArgs, STORE_EXTENSION_ID, targetBrowsers, uninstall } from "../../bridge/install-lib.mjs";

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

describe("installing the downloaded file", () => {
  it.skipIf(process.platform === "win32")("installs the file that runs, whatever the download is called, and nothing else lying in the folder", () => {
    const h = home();
    const downloads = join(h, "Downloads");
    mkdirSync(downloads);
    // An older download, a newer one Chrome renamed, and an unrelated file with a bridge name.
    writeFileSync(join(downloads, "justrefresh-bridge.mjs"), "// old\n");
    const bundle = "// new, one file\n";
    writeFileSync(join(downloads, "justrefresh-bridge (1).mjs"), bundle);
    writeFileSync(join(downloads, "lib.mjs"), "// someone else's\n");
    writeFileSync(join(downloads, "install-lib.mjs"), "// someone else's\n");
    const loc = locations({ home: h, platform: "darwin", env: { JUSTREFRESH_BRIDGE_DIR: join(h, ".justrefresh") } });
    const lines: string[] = [];
    install({
      extensionId: ID,
      sourceDir: downloads,
      entry: join(downloads, "justrefresh-bridge (1).mjs"),
      bundled: true, // as the build marks the downloadable file
      node: "/opt/homebrew/bin/node",
      loc,
      run: () => undefined,
      log: (l: string) => lines.push(l),
    });
    expect(readFileSync(join(loc.bin, "justrefresh-bridge.mjs"), "utf8")).toBe(bundle);
    expect(existsSync(join(loc.bin, "lib.mjs"))).toBe(false);
    expect(existsSync(join(loc.bin, "install-lib.mjs"))).toBe(false);

    // The settings it prints, which the setup for an AI app tells the app to use exactly.
    const printed = JSON.parse(lines.find((l) => l.startsWith("{"))!);
    expect(printed).toEqual({ mcpServers: { justrefresh: { command: "/opt/homebrew/bin/node", args: [join(loc.bin, "justrefresh-bridge.mjs"), "mcp"] } } });
  });

  it.skipIf(process.platform === "win32")("from a checkout, brings the files the bridge imports", () => {
    const h = home();
    const loc = locations({ home: h, platform: "darwin", env: { JUSTREFRESH_BRIDGE_DIR: join(h, ".justrefresh") } });
    const src = join(__dirname, "../../bridge");
    install({
      extensionId: ID,
      sourceDir: src,
      entry: join(src, "justrefresh-bridge.mjs"),
      node: "/usr/local/bin/node",
      loc,
      run: () => undefined,
      log: () => undefined,
    });
    for (const f of ["justrefresh-bridge.mjs", "lib.mjs", "install-lib.mjs"]) expect(existsSync(join(loc.bin, f)), f).toBe(true);
  });
});

describe("installing for JustRefresh from the Chrome Web Store", () => {
  it.skipIf(process.platform === "win32")("needs no extension id, and prints a ready-made claude mcp add line", () => {
    const h = home();
    const loc = locations({ home: h, platform: "darwin", env: { JUSTREFRESH_BRIDGE_DIR: join(h, ".justrefresh") } });
    const src = join(__dirname, "../../bridge");
    const lines: string[] = [];
    install({
      sourceDir: src,
      entry: join(src, "justrefresh-bridge.mjs"),
      node: "/usr/local/bin/node",
      loc,
      run: () => undefined,
      log: (l: string) => lines.push(l),
    });
    const manifest = JSON.parse(readFileSync(join(h, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.justrefresh.bridge.json"), "utf8"));
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${STORE_EXTENSION_ID}/`]);
    expect(lines.join("\n")).toContain("for JustRefresh from the Chrome Web Store");
    expect(lines).toContain(`\nClaude Code: claude mcp add --scope user justrefresh -- '/usr/local/bin/node' '${join(loc.bin, "justrefresh-bridge.mjs")}' mcp`);
    // Another copy still names its own id.
    expect(() => install({ extensionId: "not-an-id", sourceDir: src, loc, run: () => undefined, log: () => undefined })).toThrow(/32-letter id/);
  });
});

describe("install options", () => {
  it('are strict: a mistyped or empty option is refused, not taken as "the store copy"', () => {
    expect(parseInstallArgs(["install"])).toEqual({});
    expect(parseInstallArgs(["install", "--extension-id", ID, "--browser", "edge"])).toEqual({ extensionId: ID, browser: "edge" });
    expect(parseInstallArgs(["--extension-id=" + ID])).toEqual({ extensionId: ID });
    expect(() => parseInstallArgs(["install", "--extension-id"])).toThrow(/needs a value/);
    expect(() => parseInstallArgs(["install", "--extension-id", "--browser", "chrome"])).toThrow(/needs a value/);
    expect(() => parseInstallArgs(["install", "--extension-id="])).toThrow(/needs a value/);
    expect(() => parseInstallArgs(["install", "--extensionid", ID])).toThrow(/Unknown option "--extensionid"/);
    expect(() => parseInstallArgs(["install", ID])).toThrow(/Unknown option/);
  });

  it.skipIf(process.platform === "win32")("installing for one copy keeps the others it was installed for", () => {
    const h = home();
    const loc = locations({ home: h, platform: "darwin", env: { JUSTREFRESH_BRIDGE_DIR: join(h, ".justrefresh") } });
    const src = join(__dirname, "../../bridge");
    const quiet = { sourceDir: src, entry: join(src, "justrefresh-bridge.mjs"), node: "/usr/local/bin/node", loc, run: () => undefined, browser: "chrome" };
    install({ ...quiet, extensionId: ID, log: () => undefined });
    const lines: string[] = [];
    install({ ...quiet, log: (l: string) => lines.push(l) }); // the store copy
    const file = join(h, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.justrefresh.bridge.json");
    expect(JSON.parse(readFileSync(file, "utf8")).allowed_origins).toEqual([`chrome-extension://${STORE_EXTENSION_ID}/`, `chrome-extension://${ID}/`]);
    expect(lines.join("\n")).toContain(`still also for ${ID}`);
    // Installing again for the same copy doesn't list it twice.
    install({ ...quiet, log: () => undefined });
    expect(JSON.parse(readFileSync(file, "utf8")).allowed_origins).toHaveLength(2);
  });
});
