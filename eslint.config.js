// Complexity limits, enforced as part of `npm test` (tests/unit/complexity.test.ts).
//  - complexity: cyclomatic complexity (independent paths through a function)
//  - sonarjs/cognitive-complexity: how hard a function is to follow (nesting
//    and breaks in linear flow cost more)
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export const MAX_CYCLOMATIC = 15;
export const MAX_COGNITIVE = 15;

export default [
  { ignores: ["dist/**", "node_modules/**", "test-results/**", "coverage/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { sonarjs },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      complexity: ["error", { max: MAX_CYCLOMATIC }],
      "sonarjs/cognitive-complexity": ["error", MAX_COGNITIVE],
    },
  },
];
