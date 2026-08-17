import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  // The desktop client is Rust plus a tiny vanilla-JS shell; it is linted by
  // `cargo clippy` from windows-client, not by the web app's ESLint config.
  globalIgnores([
    ".next/**",
    "coverage/**",
    "next-env.d.ts",
    "windows-client/**",
  ]),
]);
