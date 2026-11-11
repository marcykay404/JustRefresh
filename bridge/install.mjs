#!/usr/bin/env node
// Registers the JustRefresh native-messaging host for Chrome/Chromium.
//
//   node bridge/install.mjs --extension-id <id> [--browser chrome|chromium|edge|brave] [--uninstall]
//
// Writes a launcher script next to this file and the host manifest into the
// browser's NativeMessagingHosts directory (macOS/Linux). On Windows it writes
// the manifest and prints the registry command to run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = "com.smartautorefresh.bridge";
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const extensionId = opt("extension-id");
const browser = opt("browser", "chrome");
const uninstall = args.includes("--uninstall");

if (!uninstall && !/^[a-p]{32}$/.test(extensionId ?? "")) {
  console.error("Pass --extension-id <32-char id> (shown in Dashboard → Agent Integrations or chrome://extensions).");
  process.exit(2);
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const home = os.homedir();
const dirs = {
  darwin: {
    chrome: "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    chromium: "Library/Application Support/Chromium/NativeMessagingHosts",
    edge: "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
    brave: "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
  },
  linux: {
    chrome: ".config/google-chrome/NativeMessagingHosts",
    chromium: ".config/chromium/NativeMessagingHosts",
    edge: ".config/microsoft-edge/NativeMessagingHosts",
    brave: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
  },
};

const isWin = process.platform === "win32";
const target = isWin ? here : path.join(home, dirs[process.platform]?.[browser] ?? dirs.linux[browser]);
const manifestPath = path.join(target, `${HOST}.json`);
const launcher = path.join(here, isWin ? "sar-native-host.bat" : "sar-native-host.sh");

if (uninstall) {
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(launcher, { force: true });
  console.log(`Removed ${manifestPath}`);
  process.exit(0);
}

const node = process.execPath;
const script = path.join(here, "sar-bridge.mjs");
if (isWin) fs.writeFileSync(launcher, `@echo off\r\n"${node}" "${script}" native-host %*\r\n`);
else fs.writeFileSync(launcher, `#!/bin/sh\nexec "${node}" "${script}" native-host "$@"\n`, { mode: 0o755 });

fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      name: HOST,
      description: "JustRefresh local agent bridge",
      path: launcher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  ),
);
console.log(`Installed native host manifest: ${manifestPath}`);
if (isWin) {
  console.log(`Now register it:\n  reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}" /ve /t REG_SZ /d "${manifestPath}" /f`);
}
console.log(`\nAdd the MCP server to your agent, e.g.:\n${JSON.stringify({ mcpServers: { "smart-auto-refresh": { command: node, args: [script, "mcp"] } } }, null, 2)}`);
