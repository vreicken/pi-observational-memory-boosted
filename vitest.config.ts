import { defineConfig } from "vitest/config";

// Nocka setup: aligned with the bc-core convention. Test include is anchored
// at the component root (`**/*.test.ts`) instead of a hand-listed directory,
// so a test file added outside tests/ is still picked up. Coverage include
// covers every .ts this component owns (src/, agent/, tests/), so a source
// file added anywhere cannot silently escape the QA floor; omissions are
// explicit below.
export default defineConfig({
	test: {
		environment: "node",
		include: ["**/*.test.ts"],
		exclude: ["node_modules"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
			// Whole-component inclusion; the lane's extension set does the
			// including. Nothing is hand-listed.
			include: ["**/*.ts"],
			// Omissions, each with its reason: test files are the exercising
			// code, not code under test. No .d.ts exists today, but the
			// exclusion is declared so generated declarations can never enter.
			exclude: ["**/*.test.ts", "**/*.d.ts"],
		},
	},
});
