// The npm package "justrefresh": the desktop bridge, as the single file the
// dashboard offers for download (built by scripts/build.mjs into dist/bridge).
//
//   npm run build:npm        → dist-npm/ (then: cd dist-npm && npm publish)
//
// It has no dependencies. `npx -y justrefresh@<version> install` copies it to
// ~/.justrefresh/bin and registers it with the browsers; AI apps then start
// that installed copy, the same one Chrome starts, so both sides match.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./script-build.mjs";
import { npmPackage } from "./npm-package.mjs";

const out = resolve(root, "dist-npm");
const bridge = resolve(root, "dist", "bridge", "justrefresh-bridge.mjs");
if (!existsSync(bridge)) throw new Error("Build the extension first (npm run build): dist/bridge/justrefresh-bridge.mjs is missing");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(bridge, resolve(out, "justrefresh-bridge.mjs"));
cpSync(resolve(root, "bridge", "npm-README.md"), resolve(out, "README.md"));
cpSync(resolve(root, "LICENSE"), resolve(out, "LICENSE"));
writeFileSync(resolve(out, "package.json"), JSON.stringify(npmPackage(pkg.version), null, 2) + "\n");
console.log(`npm package justrefresh@${pkg.version} → dist-npm/ (publish with: cd dist-npm && npm publish)`);
