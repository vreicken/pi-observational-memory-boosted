import { describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

/**
 * Compile-time contract for the actionable-boundary registrations this repo relies on
 * (observer-trigger / consolidator-trigger / eviction-flush). Nothing here runs at test time —
 * `@ts-expect-error` is the assertion, and tsc consumes it only while pi's `on("agent_start", …)`
 * stays a void-only slot that rejects a draft-returning handler. If a future pi widens that slot,
 * tsc fails with TS2578 (unused directive) and the contract this task converted the six casts
 * into gets revisited deliberately instead of quietly disappearing.
 */
describe("pi.on() boundary overloads", () => {
	it("accepts a draft-returning handler on turn_end but rejects it on agent_start", () => {
		const registerDrafts = (pi: ExtensionAPI): void => {
			// Positive control: drafts are the whole point of the actionable boundary.
			pi.on("turn_end", (): { entries: SessionBoundaryDraft[] } => ({ entries: [] }));
			// @ts-expect-error agent_start is notification-only: a result-returning handler is a type error.
			pi.on("agent_start", (): { entries: SessionBoundaryDraft[] } => ({ entries: [] }));
		};
		expect(typeof registerDrafts).toBe("function");
	});
});
