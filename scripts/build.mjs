// Builds the unpacked extension into dist/:
//   popup.html / dashboard.html (React, Vite)   background.js (ES module)   content.js (IIFE)
//   bridge/justrefresh-bridge.mjs (the desktop bridge, one file for Node)
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { onwarn, root, scriptConfig } from "./script-build.mjs";

const out = resolve(root, "dist");
const alias = { "@": resolve(root, "src") };
const common = { configFile: false, logLevel: "warn", resolve: { alias }, define: { "process.env.NODE_ENV": '"production"' } };

rmSync(out, { recursive: true, force: true });

// 1. Extension pages.
await build({
  ...common,
  root: resolve(root, "src/ui"),
  base: "./",
  plugins: [react()],
  publicDir: resolve(root, "public"),
  build: {
    outDir: out,
    emptyOutDir: false,
    target: "chrome120",
    sourcemap: false,
    rollupOptions: {
      onwarn,
      input: {
        popup: resolve(root, "src/ui/popup.html"),
        dashboard: resolve(root, "src/ui/dashboard.html"),
        offscreen: resolve(root, "src/ui/offscreen.html"),
      },
      output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});

// 2. Service worker (single ES module file) and 3. content script (classic IIFE).
for (const [entry, file, format] of [
  ["src/background/service-worker.ts", "background.js", "es"],
  ["src/content/index.ts", "content.js", "iife"],
]) {
  await build(scriptConfig({ entry, file, format, outDir: out }));
}

// 4. The desktop bridge as one file, offered for download in Dashboard → Agent Integrations
//    (`node justrefresh-bridge.mjs install --extension-id …` sets it up). Runs in Node, not Chrome.
await build({
  configFile: false,
  logLevel: "warn",
  publicDir: false,
  // The installer knows it is the downloaded single file (no lib.mjs or install-lib.mjs to copy).
  define: { __JUSTREFRESH_BUNDLED__: "true" },
  build: {
    outDir: resolve(out, "bridge"),
    emptyOutDir: false,
    target: "node18",
    minify: false,
    ssr: resolve(root, "bridge/justrefresh-bridge.mjs"),
    rollupOptions: { output: { format: "es", entryFileNames: "justrefresh-bridge.mjs", inlineDynamicImports: true } },
  },
});

// Manifest (version synced from package.json).
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
cpSync(resolve(root, "schemas"), resolve(out, "schemas"), { recursive: true });
console.log("Built extension → dist/");
