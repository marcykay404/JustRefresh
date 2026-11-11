// Installing the bridge: one command sets everything up.
//
//   node justrefresh-bridge.mjs install --extension-id <id> [--browser chrome|chromium|edge|brave]
//   node justrefresh-bridge.mjs uninstall
//
// It copies the bridge to ~/.justrefresh/bin (so the downloaded file can be
// deleted), writes the launcher Chrome starts, registers the native host with
// each Chromium browser found (or the one named), and prints the line to add
// to your AI app. On Windows it registers in the registry (HKCU, no admin needed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const HOST = "com.justrefresh.bridge";
/** What the bridge is made of: the bundled download is one file, the repo version three. */
const BRIDGE_FILES = ["justrefresh-bridge.mjs", "lib.mjs", "install-lib.mjs"];

/** Each browser's profile folder (relative to home on macOS/Linux, to %LOCALAPPDATA% on Windows). */
const PROFILE_DIRS = {
  darwin: {
    chrome: "Library/Application Support/Google/Chrome",
    chromium: "Library/Application Support/Chromium",
    edge: "Library/Application Support/Microsoft Edge",
    brave: "Library/Application Support/BraveSoftware/Brave-Browser",
  },
  linux: {
    chrome: ".config/google-chrome",
    chromium: ".config/chromium",
    edge: ".config/microsoft-edge",
    brave: ".config/BraveSoftware/Brave-Browser",
  },
  win32: {
    chrome: "Google/Chrome/User Data",
    chromium: "Chromium/User Data",
    edge: "Microsoft/Edge/User Data",
    brave: "BraveSoftware/Brave-Browser/User Data",
  },
};
const WIN_KEYS = {
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
};
export const BROWSERS = Object.keys(WIN_KEYS);

export function parseInstallArgs(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { extensionId: opt("extension-id"), browser: opt("browser") };
}

/** Where things go. `env` overrides exist for tests. */
export function locations({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const dataDir = env.JUSTREFRESH_BRIDGE_DIR ?? path.join(home, ".justrefresh");
  const profileBase = platform === "win32" ? (env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")) : home;
  return { home, platform, dataDir, bin: path.join(dataDir, "bin"), profileBase, profiles: PROFILE_DIRS[platform] ?? PROFILE_DIRS.linux };
}

/** The browsers to register with: the one named, else every one found, else Chrome. */
export function targetBrowsers(loc, browser) {
  if (browser) {
    if (!BROWSERS.includes(browser)) throw new Error(`Unknown browser "${browser}". Use one of: ${BROWSERS.join(", ")}`);
    return [browser];
  }
  const found = BROWSERS.filter((b) => fs.existsSync(path.join(loc.profileBase, loc.profiles[b])));
  return found.length ? found : ["chrome"];
}

const manifestDir = (loc, browser) => path.join(loc.profileBase, loc.profiles[browser], "NativeMessagingHosts");

function copyBridge(sourceDir, bin) {
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  if (path.resolve(sourceDir) === path.resolve(bin)) return;
  for (const f of BRIDGE_FILES) {
    if (fs.existsSync(path.join(sourceDir, f))) fs.copyFileSync(path.join(sourceDir, f), path.join(bin, f));
  }
}

function writeLauncher(loc, node) {
  const script = path.join(loc.bin, "justrefresh-bridge.mjs");
  if (loc.platform === "win32") {
    const launcher = path.join(loc.bin, "justrefresh-native-host.bat");
    fs.writeFileSync(launcher, `@echo off\r\n"${node}" "${script}" native-host %*\r\n`);
    return { launcher, script };
  }
  const launcher = path.join(loc.bin, "justrefresh-native-host.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${node}" "${script}" native-host "$@"\n`, { mode: 0o755 });
  return { launcher, script };
}

function register(loc, browsers, manifest, run) {
  const json = JSON.stringify(manifest, null, 2);
  if (loc.platform === "win32") {
    const file = path.join(loc.bin, `${HOST}.json`);
    fs.writeFileSync(file, json);
    for (const b of browsers) run("reg", ["add", `${WIN_KEYS[b]}\\${HOST}`, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
    return browsers.map((b) => `${b}: ${WIN_KEYS[b]}\\${HOST}`);
  }
  return browsers.map((b) => {
    fs.mkdirSync(manifestDir(loc, b), { recursive: true });
    const file = path.join(manifestDir(loc, b), `${HOST}.json`);
    fs.writeFileSync(file, json);
    return `${b}: ${file}`;
  });
}

export function install({ extensionId, browser, sourceDir, node = process.execPath, loc = locations(), run = execFileSync, log = console.log }) {
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
    throw new Error("Pass --extension-id <32-letter id>. JustRefresh shows it in Dashboard → Agent Integrations, with this command ready to copy.");
  }
  const browsers = targetBrowsers(loc, browser);
  copyBridge(sourceDir, loc.bin);
  const { launcher, script } = writeLauncher(loc, node);
  const manifest = {
    name: HOST,
    description: "JustRefresh local agent bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const registered = register(loc, browsers, manifest, run);
  log(`Installed the JustRefresh bridge in ${loc.bin}`);
  for (const r of registered) log(`  registered with ${r}`);
  log("\nNext: restart JustRefresh if the dashboard asks, then add this to your AI app's MCP settings:");
  log(JSON.stringify({ mcpServers: { justrefresh: { command: node, args: [script, "mcp"] } } }, null, 2));
  log("\nWhen the app first connects, approve it in JustRefresh → Dashboard → Agent Integrations.");
  return { browsers, launcher, script };
}

export function uninstall({ loc = locations(), run = execFileSync, log = console.log } = {}) {
  for (const b of BROWSERS) {
    if (loc.platform === "win32") {
      try {
        run("reg", ["delete", `${WIN_KEYS[b]}\\${HOST}`, "/f"], { stdio: "ignore" });
      } catch {
        /* not registered there */
      }
    } else fs.rmSync(path.join(manifestDir(loc, b), `${HOST}.json`), { force: true });
  }
  fs.rmSync(loc.bin, { recursive: true, force: true });
  log(`Removed the JustRefresh bridge (${loc.bin}) and its registration with your browsers.`);
}
