// Plain-Node flat config. No framework plugin —
// this is a pi extension process, not a web app.
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["coverage/**", "node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The .mjs scripts are plain Node — js.configs.recommended's no-undef needs
  // the Node globals declared for them (the TS files are covered by tsc).
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
]);
