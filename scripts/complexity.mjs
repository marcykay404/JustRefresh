// Complexity check with a ratchet.
//
// Every function in src/ must stay at or below the limits in eslint.config.js
// (cyclomatic and cognitive complexity). complexity-baseline.json can list
// functions allowed over the limit at their current score, which may only go
// down. It is empty now: every function is within the limits.
//
//   node scripts/complexity.mjs          report (exit 1 on a problem)
//   node scripts/complexity.mjs --update lower the baseline to the code (never adds or raises an entry)
//
// tests/unit/complexity.test.ts runs the same check as part of `npm test`.
import { ESLint } from "eslint";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const BASELINE_FILE = resolve(root, "complexity-baseline.json");
const RULES = { complexity: "cyclomatic", "sonarjs/cognitive-complexity": "cognitive" };
const KINDS = ["cyclomatic", "cognitive"];

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
    // Belt and braces: anything suppressed for these rules counts as an error.
    for (const m of r.suppressedMessages ?? []) {
      if (RULES[m.ruleId]) errors.push(`${file}:${m.line} ${m.ruleId} is suppressed; the complexity limits can't be switched off inline`);
    }
    for (const m of r.messages) {
      const kind = RULES[m.ruleId];
      if (!kind) {
        errors.push(`${file}:${m.line} ${m.ruleId ?? "parse"}: ${m.message}`);
        continue;
      }
      const score = Number((m.message.match(/complexity of (\d+)/) ?? m.message.match(/from (\d+) to/) ?? [])[1]);
      if (!Number.isFinite(score)) {
        errors.push(`${file}:${m.line} ${m.ruleId}: could not read the score from "${m.message}"`);
        continue;
      }
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
  for (const kind of KINDS) {
    const now = current[kind];
    const was = baseline[kind] ?? {};
    for (const [key, score] of Object.entries(now)) {
      if (!Object.hasOwn(was, key)) problems.push(`${kind} ${score} (over the limit): ${key}. Split or simplify it.`);
      else if (score > was[key]) problems.push(`${kind} rose from ${was[key]} to ${score}: ${key}. Simplify it back.`);
      else if (score < was[key]) problems.push(`${kind} fell from ${was[key]} to ${score}: ${key}. Lower the baseline (npm run complexity:update).`);
    }
    for (const key of Object.keys(was)) {
      if (!Object.hasOwn(now, key)) problems.push(`${kind} is now within the limit: ${key}. Remove it from the baseline (npm run complexity:update).`);
    }
  }
  return problems;
}

/**
 * The baseline lowered to the code: an improved entry goes down, one within
 * the limit goes away. A new offender is never added and a worse one never
 * raised, so --update can't be used to accept more complexity.
 */
export function lowered(current, baseline) {
  const out = { cyclomatic: {}, cognitive: {} };
  for (const kind of KINDS) {
    const was = baseline[kind] ?? {};
    const keys = Object.keys(current[kind]).filter((k) => Object.hasOwn(was, k)).sort((a, b) => a.localeCompare(b));
    for (const key of keys) out[kind][key] = Math.min(current[kind][key], was[key]);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { offenders, errors } = await measure();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const baseline = readBaseline();
  if (process.argv.includes("--update")) {
    const next = lowered(offenders, baseline);
    writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + "\n");
    console.log(`Baseline: ${Object.keys(next.cyclomatic).length} cyclomatic, ${Object.keys(next.cognitive).length} cognitive entries`);
  }
  const problems = compare(offenders, readBaseline());
  console.log(problems.length ? problems.join("\n") : "Complexity OK");
  process.exit(problems.length ? 1 : 0);
}
