// How the service worker and the content script are built, shared by
// build.mjs and bundle-report.mjs so the size budget measures what ships.
//
// Each is built as an app entry, not in Vite's library mode: library mode
// keeps whitespace in ES-module output (so that libraries stay tree-shakeable
// for their users), which made background.js about 40% larger.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

const onwarn = (w, warn) => {
  // zod ships comments rollup can't place; harmless.
  if (w.code === "INVALID_ANNOTATION" || /annotation that Rollup cannot interpret/.test(w.message)) return;
  warn(w);
};

/** Vite config for one script: `format` "es" (service worker module) or "iife" (content script). */
export function scriptConfig({ entry, file, format, outDir, write = true }) {
  return {
    configFile: false,
    logLevel: write ? "warn" : "silent",
    resolve: { alias: { "@": resolve(root, "src") } },
    define: { "process.env.NODE_ENV": '"production"' },
    publicDir: false,
    build: {
      write,
      outDir,
      emptyOutDir: false,
      target: "chrome120",
      minify: true,
      modulePreload: false,
      rollupOptions: {
        onwarn,
        input: resolve(root, entry),
        output: { format, entryFileNames: file, inlineDynamicImports: true },
      },
    },
  };
}
