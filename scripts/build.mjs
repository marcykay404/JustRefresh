// Builds the unpacked extension into dist/:
//   popup.html / dashboard.html (React, Vite)   background.js (ES module)   content.js (IIFE)
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(root, "dist");
const alias = { "@": resolve(root, "src") };
const onwarn = (w, warn) => {
  // zod ships comments rollup can't place; harmless.
  if (w.code === "INVALID_ANNOTATION" || /annotation that Rollup cannot interpret/.test(w.message)) return;
  warn(w);
};
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
      input: { popup: resolve(root, "src/ui/popup.html"), dashboard: resolve(root, "src/ui/dashboard.html") },
      output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});

// 2. Service worker (single ES module file) and 3. content script (classic IIFE).
for (const [entry, file, format] of [
  ["src/background/service-worker.ts", "background.js", "es"],
  ["src/content/index.ts", "content.js", "iife"],
]) {
  await build({
    ...common,
    publicDir: false,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: "chrome120",
      minify: true,
      lib: { entry: resolve(root, entry), formats: [format], name: "sar", fileName: () => file },
      rollupOptions: { onwarn, output: { inlineDynamicImports: true } },
    },
  });
}

// Manifest (version synced from package.json).
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
cpSync(resolve(root, "schemas"), resolve(out, "schemas"), { recursive: true });
console.log("Built extension → dist/");
