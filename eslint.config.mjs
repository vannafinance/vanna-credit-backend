import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const warningRules = new Set([
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-require-imports",
  "prefer-const",
  "react/no-unescaped-entities",
  "react-hooks/purity",
  "react-hooks/set-state-in-effect",
  "react-hooks/preserve-manual-memoization",
  "react-hooks/immutability",
]);

const relaxedNextConfig = [...nextVitals, ...nextTs].map((config) => ({
  ...config,
  rules: Object.fromEntries(
    Object.entries(config.rules ?? {}).map(([name, setting]) => [name, warningRules.has(name) ? "warn" : setting]),
  ),
}));

const eslintConfig = defineConfig([
  ...relaxedNextConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
