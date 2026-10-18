// Nocka setup: same plain-Node flat-config baseline as bc-core
// (<baseline-config>). No framework plugin —
// this is a pi extension process, not a web app.
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["coverage/**", "node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
]);
