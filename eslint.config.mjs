// Nocka setup: same plain-Node flat-config baseline as bc-core
// (E:/Projects/Nocka/apps/bc-core/eslint.config.mjs). No framework plugin —
// this is a pi extension process, not a web app.
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["coverage/**", "node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
]);
