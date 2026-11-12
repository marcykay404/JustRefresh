// Installing the bridge: one command sets everything up.
//
//   node justrefresh-bridge.mjs install --extension-id <id> [--browser chrome|chrome-beta|…|vivaldi|arc]
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
import { BRIDGE_FILE, DATA_DIR_NAME, MCP_SERVER_KEY } from "./lib.mjs";

export const HOST = "com.justrefresh.bridge";
/** JustRefresh from the Chrome Web Store: the extension the bridge is for unless --extension-id names another copy. */
export const STORE_EXTENSION_ID = "hgdoldonldledoimnhlpkmipchjfgolf";
/** What the bridge is made of: the bundled download is one file, the repo version three. */
const BRIDGE_FILES = [BRIDGE_FILE, "lib.mjs", "install-lib.mjs"];

/* global __JUSTREFRESH_BUNDLED__ */
/** Set by scripts/build.mjs in the downloadable bridge, which is one file with everything inlined. */
const BUNDLED = typeof __JUSTREFRESH_BUNDLED__ !== "undefined" && __JUSTREFRESH_BUNDLED__ === true;

/**
 * Each browser's profile folder (relative to home on macOS, to
 * $XDG_CONFIG_HOME on Linux, to %LOCALAPPDATA% on Windows), where it looks
 * for NativeMessagingHosts. A browser missing on a platform isn't made there.
 * Chrome's channels, Vivaldi and Arc follow Chrome's layout; their paths
 * aren't documented by the browsers, so they are best effort.
 */
const PROFILE_DIRS = {
  darwin: {
    chrome: "Library/Application Support/Google/Chrome",
    "chrome-beta": "Library/Application Support/Google/Chrome Beta",
    "chrome-dev": "Library/Application Support/Google/Chrome Dev",
    "chrome-canary": "Library/Application Support/Google/Chrome Canary",
    chromium: "Library/Application Support/Chromium",
    edge: "Library/Application Support/Microsoft Edge",
    brave: "Library/Application Support/BraveSoftware/Brave-Browser",
    vivaldi: "Library/Application Support/Vivaldi",
    arc: "Library/Application Support/Arc/User Data",
  },
  linux: {
    chrome: "google-chrome",
    "chrome-beta": "google-chrome-beta",
    "chrome-dev": "google-chrome-unstable",
    "chrome-canary": "google-chrome-canary",
    chromium: "chromium",
    edge: "microsoft-edge",
    brave: "BraveSoftware/Brave-Browser",
    vivaldi: "vivaldi",
  },
  win32: {
    chrome: "Google/Chrome/User Data",
    "chrome-beta": "Google/Chrome Beta/User Data",
    "chrome-dev": "Google/Chrome Dev/User Data",
    "chrome-canary": "Google/Chrome SxS/User Data",
    chromium: "Chromium/User Data",
    edge: "Microsoft/Edge/User Data",
    brave: "BraveSoftware/Brave-Browser/User Data",
    vivaldi: "Vivaldi/User Data",
  },
};
/**
 * Windows registry keys (HKCU) each browser reads. Every Chrome channel reads
 * Chrome's; Vivaldi gets its own and Chrome's (Chromium-based browsers fall
 * back to Chrome's key).
 */
const CHROME_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts";
const WIN_KEYS = {
  chrome: [CHROME_KEY],
  "chrome-beta": [CHROME_KEY],
  "chrome-dev": [CHROME_KEY],
  "chrome-canary": [CHROME_KEY],
  chromium: ["HKCU\\Software\\Chromium\\NativeMessagingHosts"],
  edge: ["HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts"],
  brave: ["HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts"],
  vivaldi: ["HKCU\\Software\\Vivaldi\\NativeMessagingHosts", CHROME_KEY],
};
export const BROWSERS = Object.keys(PROFILE_DIRS.darwin);

/** The registry keys to write for these browsers, each once. */
const winKeys = (browsers) => [...new Set(browsers.flatMap((b) => WIN_KEYS[b] ?? []))];

const INSTALL_OPTIONS = { "extension-id": "extensionId", browser: "browser" };

/**
 * `install [--extension-id <id>] [--browser <name>]` (also `--name=value`).
 * Strict: a mistyped or empty option is refused, never ignored, since leaving
 * the id out means "JustRefresh from the Chrome Web Store".
 */
export function parseInstallArgs(argv) {
  const args = argv[0] === "install" ? argv.slice(1) : argv;
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    const key = m && Object.hasOwn(INSTALL_OPTIONS, m[1]) ? INSTALL_OPTIONS[m[1]] : null;
    if (!key) throw new Error(`Unknown option "${args[i]}". Options: --extension-id <id>, --browser <name>.`);
    const value = m[2] ?? args[++i];
    if (!value || value.startsWith("--")) throw new Error(`--${m[1]} needs a value.`);
    out[key] = value;
  }
  return out;
}

/** Where things go. `env` overrides exist for tests. */
export function locations({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const dataDir = env.JUSTREFRESH_BRIDGE_DIR ?? path.join(home, DATA_DIR_NAME);
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
  const here = BROWSERS.filter((b) => Object.hasOwn(loc.profiles, b));
  if (browser) {
    if (!here.includes(browser)) throw new Error(`Unknown browser "${browser}" here. Use one of: ${here.join(", ")}`);
    return [browser];
  }
  const found = here.filter((b) => fs.existsSync(path.join(loc.profileBase, loc.profiles[b])));
  return found.length ? found : ["chrome"];
}

const manifestDir = (loc, browser) => path.join(loc.profileBase, loc.profiles[browser], "NativeMessagingHosts");

/**
 * Copy the bridge into `bin`. `entry` is the file that is running: that one is
 * the bridge, whatever the download was called ("justrefresh-bridge (1).mjs"
 * for a second download, next to an older one). The downloaded bridge is one
 * file; only a checkout's, which imports the others, brings them along.
 */
function copyBridge(sourceDir, bin, entry, bundled) {
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const [main, ...others] = BRIDGE_FILES;
  if (entry && path.resolve(entry) !== path.resolve(bin, main)) fs.copyFileSync(entry, path.join(bin, main));
  if (path.resolve(sourceDir) === path.resolve(bin)) return;
  const files = !entry ? BRIDGE_FILES : bundled ? [] : others;
  for (const f of files) {
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

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;

/**
 * Extensions the bridge is already registered for here (an earlier install, e.g.
 * for an unpacked copy): kept, so installing for one copy doesn't cut off another.
 */
function registeredOrigins(loc, browsers) {
  const files = loc.platform === "win32" ? [path.join(loc.bin, `${HOST}.json`)] : browsers.map((b) => path.join(manifestDir(loc, b), `${HOST}.json`));
  const found = new Set();
  for (const file of files) {
    try {
      for (const o of JSON.parse(fs.readFileSync(file, "utf8")).allowed_origins ?? []) if (EXTENSION_ORIGIN.test(o)) found.add(o);
    } catch {
      // Not registered there yet.
    }
  }
  return [...found];
}

function register(loc, browsers, manifest, run) {
  const json = JSON.stringify(manifest, null, 2);
  if (loc.platform === "win32") {
    const file = path.join(loc.bin, `${HOST}.json`);
    fs.writeFileSync(file, json);
    const keys = winKeys(browsers);
    for (const k of keys) run("reg", ["add", `${k}\\${HOST}`, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
    return [`${browsers.join(", ")}: ${keys.map((k) => `${k}\\${HOST}`).join(", ")}`];
  }
  return browsers.map((b) => {
    fs.mkdirSync(manifestDir(loc, b), { recursive: true });
    const file = path.join(manifestDir(loc, b), `${HOST}.json`);
    fs.writeFileSync(file, json);
    return `${b}: ${file}`;
  });
}

export function install({
  extensionId = STORE_EXTENSION_ID,
  browser,
  sourceDir,
  entry,
  bundled = BUNDLED,
  node = stableNode(),
  loc = locations(),
  run = execFileSync,
  log = console.log,
}) {
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
    throw new Error(
      "--extension-id must be a 32-letter id. JustRefresh shows it in Dashboard → Agent Integrations, with this command ready to copy; leave it out for JustRefresh from the Chrome Web Store.",
    );
  }
  const browsers = targetBrowsers(loc, browser);
  const own = `chrome-extension://${extensionId}/`;
  const kept = registeredOrigins(loc, browsers).filter((o) => o !== own);
  fs.mkdirSync(loc.dataDir, { recursive: true, mode: 0o700 });
  restrictToUser(loc.dataDir, { platform: loc.platform, run, log });
  copyBridge(sourceDir, loc.bin, entry, bundled);
  const { launcher, script } = writeLauncher(loc, node);
  const manifest = {
    name: HOST,
    description: "JustRefresh local agent bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: [own, ...kept],
  };
  const registered = register(loc, browsers, manifest, run);
  log(`Installed the JustRefresh bridge in ${loc.bin}`);
  log(
    extensionId === STORE_EXTENSION_ID
      ? `  for JustRefresh from the Chrome Web Store (${extensionId}); for another copy, run again with --extension-id <its id>`
      : `  for the JustRefresh extension ${extensionId}`,
  );
  if (kept.length) log(`  still also for ${kept.map((o) => o.slice("chrome-extension://".length, -1)).join(", ")} (installed before; uninstall to start over)`);
  for (const r of registered) log(`  registered with ${r}`);
  log("\nNext: restart JustRefresh if the dashboard asks, then add this to your AI app's MCP settings:");
  log(JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: node, args: [script, "mcp"] } } }, null, 2));
  // Quoted for the shell people use there: single quotes keep $ and ` literal in sh; PowerShell, cmd and Git Bash take double quotes.
  const q = loc.platform === "win32" ? (p) => `"${p}"` : shQuote;
  log(`\nClaude Code: claude mcp add --scope user ${MCP_SERVER_KEY} -- ${q(node)} ${q(script)} mcp`);
  log("\nWhen the app first connects, approve it in JustRefresh → Dashboard → Agent Integrations.");
  log("If you switch Node versions (nvm, a new Homebrew Node), run this install again.");
  return { browsers, launcher, script };
}

export function uninstall({ loc = locations(), run = execFileSync, log = console.log } = {}) {
  if (loc.platform === "win32") {
    for (const k of winKeys(BROWSERS)) {
      try {
        run("reg", ["delete", `${k}\\${HOST}`, "/f"], { stdio: "ignore" });
      } catch {
        /* not registered there */
      }
    }
  } else {
    for (const b of BROWSERS.filter((x) => Object.hasOwn(loc.profiles, x))) fs.rmSync(path.join(manifestDir(loc, b), `${HOST}.json`), { force: true });
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
