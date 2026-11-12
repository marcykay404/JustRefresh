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
  // Relative to $XDG_CONFIG_HOME (default ~/.config).
  linux: {
    chrome: "google-chrome",
    chromium: "chromium",
    edge: "microsoft-edge",
    brave: "BraveSoftware/Brave-Browser",
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
  const bases = {
    win32: env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
    darwin: home,
    linux: env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
  };
  const known = Object.hasOwn(PROFILE_DIRS, platform) ? platform : "linux";
  return { home, platform, dataDir, bin: path.join(dataDir, "bin"), profileBase: bases[known], profiles: PROFILE_DIRS[known] };
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

/** A path as one word for sh: single-quoted, so $, ` and " stay literal. */
export const shQuote = (p) => `'${p.replace(/'/g, "'\\''")}'`;

/**
 * A stable path to Node: Homebrew and similar installs run a versioned binary
 * (…/Cellar/node/22.1.0/bin/node) behind a symlink that survives upgrades.
 */
export function stableNode(execPath = process.execPath, candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const target = real(execPath);
  return candidates.find((c) => target && real(c) === target) ?? execPath;
}

function writeLauncher(loc, node) {
  const script = path.join(loc.bin, "justrefresh-bridge.mjs");
  if (loc.platform === "win32") {
    const launcher = path.join(loc.bin, "justrefresh-native-host.bat");
    // %~dp0 is this file's folder, so the user's profile path never appears in it; UTF-8 for a non-ASCII Node path, %% for a literal %.
    const nodePath = node.replace(/%/g, "%%");
    fs.writeFileSync(launcher, `@echo off\r\nchcp 65001 >nul\r\n"${nodePath}" "%~dp0justrefresh-bridge.mjs" native-host %*\r\n`);
    return { launcher, script };
  }
  const launcher = path.join(loc.bin, "justrefresh-native-host.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shQuote(node)} ${shQuote(script)} native-host "$@"\n`, { mode: 0o755 });
  return { launcher, script };
}

/** Windows: limit a folder to this account (file modes don't apply there). Unix: 0700. */
export function restrictToUser(dir, { platform = process.platform, run = execFileSync, log = console.warn } = {}) {
  if (platform !== "win32") return fs.chmodSync(dir, 0o700);
  const user = os.userInfo().username;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  try {
    run("icacls", [dir, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`], { stdio: "ignore" });
  } catch (e) {
    log(`Could not limit ${dir} to your Windows account (${e.message}); other accounts on this PC may be able to read it.`);
  }
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

export function install({ extensionId, browser, sourceDir, node = stableNode(), loc = locations(), run = execFileSync, log = console.log }) {
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
    throw new Error("Pass --extension-id <32-letter id>. JustRefresh shows it in Dashboard → Agent Integrations, with this command ready to copy.");
  }
  const browsers = targetBrowsers(loc, browser);
  fs.mkdirSync(loc.dataDir, { recursive: true, mode: 0o700 });
  restrictToUser(loc.dataDir, { platform: loc.platform, run, log });
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
  log("If you switch Node versions (nvm, a new Homebrew Node), run this install again.");
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
  // Only what install put there; the folder goes only if nothing else is in it.
  for (const f of [...BRIDGE_FILES, "justrefresh-native-host.sh", "justrefresh-native-host.bat", `${HOST}.json`])
    fs.rmSync(path.join(loc.bin, f), { force: true });
  try {
    fs.rmdirSync(loc.bin);
  } catch {
    /* not empty (other files) or already gone */
  }
  log(`Removed the JustRefresh bridge from ${loc.bin} and its registration with your browsers.`);
}
