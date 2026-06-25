import { describe, expect, it } from "vitest";

import { StatusController, type StatusUI } from "../src/ui/status-controller.js";

function fakeUI() {
	const status = new Map<string, string | undefined>();
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: () => {},
		// Strip color so assertions read the raw glyphs.
		theme: { fg: (_color, text) => text },
	};
	return { ui, footer: () => status.get("om") };
}

describe("StatusController footer gauges", () => {
	it("shows a bare footer until gauges are set", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBe("om");
	});

	it("renders observer + consolidate + context fill bars", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 0, poolMax: 10_000, ctxValue: 40_000, ctxMax: 80_000 });
		// next 4/8, pool 0/8, ctx 4/8
		expect(footer()).toBe("om  O▕████░░░░▏  C▕░░░░░░░░▏  X▕████░░░░▏");
	});

	it("caps a full/over-threshold gauge at all cells", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 0, nextMax: 3000, poolValue: 25_000, poolMax: 10_000, ctxValue: 80_000, ctxMax: 80_000 });
		expect(footer()).toBe("om  O▕░░░░░░░░▏  C▕████████▏  X▕████████▏");
	});

	it("clearing gauges returns to the bare footer", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 5000, poolMax: 10_000, ctxValue: 10_000, ctxMax: 80_000 });
		sc.setGauges(undefined);
		expect(footer()).toBe("om");
	});
});
