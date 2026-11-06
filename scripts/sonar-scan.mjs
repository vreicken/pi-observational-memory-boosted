/**
 * Manual SonarQube scan trigger. Reads SONAR_SCANNER_TOKEN from this repo's
 * .env (never through a shell command line) and hands it to the scanner as
 * SONAR_TOKEN. Scanning can also run without this, directly via the git hook.
 *
 * Scanner binary is looked up as:
 *   1. $SONAR_SCANNER_BIN, or
 *   2. `sonar-scanner` resolved from PATH.
 */
import { spawnSync } from "node:child_process";

const token = process.env.SONAR_SCANNER_TOKEN;
if (!token) {
	console.error("SONAR_SCANNER_TOKEN not set in .env — scan skipped.");
	process.exit(1);
}

const scanner = process.env.SONAR_SCANNER_BIN ?? "sonar-scanner";

const result = spawnSync(scanner, [], {
	stdio: "inherit",
	shell: true,
	env: { ...process.env, SONAR_TOKEN: token },
});
process.exit(result.status ?? 1);
