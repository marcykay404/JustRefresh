// What the service worker bundle is made of, and a size budget for it.
//
//   node scripts/bundle-report.mjs [entry] [--max-kb N]
//
// Builds the entry (default: the service worker) the way scripts/build.mjs
// does (script-build.mjs), in memory, and prints the minified size and the
// largest inputs (unminified). With --max-kb, exits 1 when the bundle is larger.
import { build } from "vite";
import { root, scriptConfig } from "./script-build.mjs";
const args = process.argv.slice(2);
const maxIndex = args.indexOf("--max-kb");
const maxKb = maxIndex >= 0 ? Number(args[maxIndex + 1]) : null;
const entry = args.find((a, i) => !a.startsWith("--") && i !== maxIndex + 1) ?? "src/background/service-worker.ts";

const format = entry.includes("content") ? "iife" : "es";
const r = await build(scriptConfig({ entry, file: "x.js", format, write: false }));
const chunk = (Array.isArray(r) ? r[0] : r).output[0];
const by = {};
for (const [id, m] of Object.entries(chunk.modules)) {
  const k = id.includes("node_modules/")
    ? id.split("node_modules/")[1].split("/").slice(0, 3).join("/")
    : id.replace(`${root}`, "").split("/").slice(0, 2).join("/");
  by[k] = (by[k] || 0) + m.renderedLength;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${entry}: ${kb(chunk.code.length)} minified`);
console.log(
  Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `  ${kb(v).padStart(9)}  ${k}`)
    .join("\n"),
);
if (maxKb !== null && chunk.code.length > maxKb * 1024) {
  console.error(`Over budget: ${kb(chunk.code.length)} > ${maxKb} KB`);
  process.exit(1);
}
