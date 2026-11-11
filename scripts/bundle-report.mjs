// What the service worker bundle is made of, and a size budget for it.
//
//   node scripts/bundle-report.mjs [entry] [--max-kb N]
//
// Builds the entry (default: the service worker) the way scripts/build.mjs
// does, in memory, and prints the minified size and the largest inputs
// (unminified). With --max-kb, exits 1 when the bundle is larger.
import { build } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const maxIndex = args.indexOf("--max-kb");
const maxKb = maxIndex >= 0 ? Number(args[maxIndex + 1]) : null;
const entry = args.find((a, i) => !a.startsWith("--") && i !== maxIndex + 1) ?? "src/background/service-worker.ts";

const r = await build({
  configFile: false,
  logLevel: "silent",
  resolve: { alias: { "@": resolve(root, "src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  publicDir: false,
  build: { write: false, target: "chrome120", minify: true, lib: { entry: resolve(root, entry), formats: ["es"], fileName: () => "x.js" }, rollupOptions: { output: { inlineDynamicImports: true } } },
});
const chunk = (Array.isArray(r) ? r[0] : r).output[0];
const by = {};
for (const [id, m] of Object.entries(chunk.modules)) {
  const k = id.includes("node_modules/") ? id.split("node_modules/")[1].split("/").slice(0, 3).join("/") : id.replace(`${root}`, "").split("/").slice(0, 2).join("/");
  by[k] = (by[k] || 0) + m.renderedLength;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${entry}: ${kb(chunk.code.length)} minified`);
console.log(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${kb(v).padStart(9)}  ${k}`).join("\n"));
if (maxKb !== null && chunk.code.length > maxKb * 1024) {
  console.error(`Over budget: ${kb(chunk.code.length)} > ${maxKb} KB`);
  process.exit(1);
}
