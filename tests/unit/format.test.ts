/**
 * Every file Prettier can format is formatted (config: .prettierrc.json,
 * skipped files: .prettierignore). Fix with `npm run format`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as prettier from "prettier";

it("all files are formatted with Prettier (run npm run format)", async () => {
  // Tracked files plus new ones not yet added, as git sees them.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const unformatted: string[] = [];
  for (const file of files) {
    const info = await prettier.getFileInfo(file, { ignorePath: ".prettierignore" });
    if (info.ignored || !info.inferredParser) continue;
    const options = { ...(await prettier.resolveConfig(file)), filepath: file };
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // deleted in the working tree but not yet staged
    }
    if (!(await prettier.check(source, options))) unformatted.push(file);
  }
  expect(unformatted).toEqual([]);
}, 60_000);
