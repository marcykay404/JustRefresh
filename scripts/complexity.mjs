// Complexity check with a ratchet.
//
// Every function in src/ must stay at or below the limits in eslint.config.js
// (cyclomatic and cognitive complexity). Functions that were already over
// when the check was introduced are listed in complexity-baseline.json with
// their score, which may only go down.
//
//   node scripts/complexity.mjs          report (exit 1 on a problem)
//   node scripts/complexity.mjs --update rewrite the baseline from the code
//
// tests/unit/complexity.test.ts runs the same check as part of `npm test`.
import { ESLint } from "eslint";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const BASELINE_FILE = resolve(root, "complexity-baseline.json");
const RULES = { complexity: "cyclomatic", "sonarjs/cognitive-complexity": "cognitive" };

/** Current offenders: { cyclomatic: { key: score }, cognitive: { key: score } }. */
export async function measure() {
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
  const out = { cyclomatic: {}, cognitive: {} };
  const errors = [];
  for (const r of results) {
    const file = relative(root, r.filePath);
    const lines = readFileSync(r.filePath, "utf8").split("\n");
    const seen = {};
    for (const m of r.messages) {
      const kind = RULES[m.ruleId];
      if (!kind) {
        errors.push(`${file}:${m.line} ${m.ruleId ?? "parse"}: ${m.message}`);
        continue;
      }
      const score = Number((m.message.match(/complexity of (\d+)/) ?? m.message.match(/from (\d+) to/) ?? [])[1]);
      // Key: the function's first line (stable while its signature is), plus
      // an ordinal for identical lines in one file.
      const head = (lines[m.line - 1] ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
      const base = `${file} | ${head}`;
      seen[`${kind}${base}`] = (seen[`${kind}${base}`] ?? 0) + 1;
      const key = seen[`${kind}${base}`] > 1 ? `${base} | #${seen[`${kind}${base}`]}` : base;
      out[kind][key] = score;
    }
  }
  return { offenders: out, errors };
}

export function readBaseline() {
  return existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { cyclomatic: {}, cognitive: {} };
}

/** Problems comparing the code with the baseline (empty = OK). */
export function compare(current, baseline) {
  const problems = [];
  for (const kind of ["cyclomatic", "cognitive"]) {
    const now = current[kind];
    const was = baseline[kind] ?? {};
    for (const [key, score] of Object.entries(now)) {
      if (!(key in was)) problems.push(`${kind} ${score} (over the limit): ${key}. Split or simplify it.`);
      else if (score > was[key]) problems.push(`${kind} rose from ${was[key]} to ${score}: ${key}. Simplify it back.`);
      else if (score < was[key]) problems.push(`${kind} fell from ${was[key]} to ${score}: ${key}. Lower the baseline (npm run complexity:update).`);
    }
    for (const key of Object.keys(was)) {
      if (!(key in now)) problems.push(`${kind} is now within the limit: ${key}. Remove it from the baseline (npm run complexity:update).`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { offenders, errors } = await measure();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  if (process.argv.includes("--update")) {
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_FILE, JSON.stringify({ cyclomatic: sorted(offenders.cyclomatic), cognitive: sorted(offenders.cognitive) }, null, 2) + "\n");
    console.log(`Baseline: ${Object.keys(offenders.cyclomatic).length} cyclomatic, ${Object.keys(offenders.cognitive).length} cognitive offenders`);
  } else {
    const problems = compare(offenders, readBaseline());
    console.log(problems.length ? problems.join("\n") : "Complexity OK");
    process.exit(problems.length ? 1 : 0);
  }
}
