import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
  ]),
  {
    // Two React-Compiler-era rules that upstream's own commits
    // consistently violate — probably because their CI has been
    // stuck on "action_required" for a while, so nobody sees the
    // errors before merging. We can't fix upstream's files
    // downstream without triggering merge conflicts on every
    // subsequent pull, so we downgrade the pair to warnings.
    //
    // Both stay actionable in the console output (yellow warns
    // are still visible in CI logs) but stop blocking deploys.
    // Revisit periodically: once upstream re-enables their CI
    // and cleans these up, promote back to `error`.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // Also downgraded — fires when a function is `use`d in an effect
      // above its declaration site (function hoisting). Upstream has
      // this pattern in contact-form.tsx and other places.
      "react-hooks/immutability": "warn",
    },
  },
]);

export default eslintConfig;
