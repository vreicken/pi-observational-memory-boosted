/**
 * Manual SonarQube scan trigger. Reads SONAR_SCANNER_TOKEN from this repo's
 * .env (never through a shell command line) and hands it to the scanner as
 * SONAR_TOKEN. Application convention mirrors <sibling-project>'s post-commit hook;
 * scanning can also run without this, directly via the git hook.
 */
import { spawnSync } from "node:child_process";

const token = process.env.SONAR_SCANNER_TOKEN;
if (!token) {
	console.error("SONAR_SCANNER_TOKEN not set in .env — scan skipped.");
	process.exit(1);
}

const scanner =
	"<scanner-binary>";

const result = spawnSync(scanner, [], {
	stdio: "inherit",
	shell: true,
	env: { ...process.env, SONAR_TOKEN: token },
});
process.exit(result.status ?? 1);
