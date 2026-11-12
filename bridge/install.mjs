#!/usr/bin/env node
// Registers the JustRefresh native-messaging host. Same as
// `node bridge/justrefresh-bridge.mjs install …`; see install-lib.mjs.
//
//   node bridge/install.mjs --extension-id <id> [--browser chrome|chromium|edge|brave] [--uninstall]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, parseInstallArgs, uninstall } from "./install-lib.mjs";

const argv = process.argv.slice(2);
try {
  if (argv.includes("--uninstall")) uninstall();
  else install({ ...parseInstallArgs(argv), sourceDir: path.dirname(fileURLToPath(import.meta.url)) });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
