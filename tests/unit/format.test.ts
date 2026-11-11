/**
 * Every file Prettier can format is formatted (config: .prettierrc.json,
 * skipped files: .prettierignore). Runs Prettier's own CLI, so it checks
 * exactly what `npm run format:check` does. Fix with `npm run format`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

it("all files are formatted with Prettier (run npm run format)", () => {
  const cli = fileURLToPath(new URL("node_modules/prettier/bin/prettier.cjs", `file://${root}`));
  const r = spawnSync(process.execPath, [cli, "--list-different", "."], { cwd: root, encoding: "utf8" });
  // Exit 1 lists the unformatted files; anything else (2) is an error in Prettier itself.
  expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
  expect(r.stdout.split("\n").filter(Boolean)).toEqual([]);
}, 60_000);
