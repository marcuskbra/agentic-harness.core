/**
 * The web check command's refusals.
 *
 * Everything past validation drives a real browser and is
 * exercised by the browser lane through the session it uses;
 * what belongs here is that a bad ask is refused before a
 * browser is ever paid for.
 */

import { describe, expect, it } from "vitest";
import { runWebCheck, WEB_CHECK_KINDS } from "../../bin/web.js";

describe("runWebCheck refusals", () => {
	it("refuses stdin that is not JSON", async () => {
		const out = await runWebCheck("not json");
		expect(out.ok).toBe(false);
		expect(out.error).toContain("JSON");
	});

	it("refuses a missing url", async () => {
		const out = await runWebCheck(JSON.stringify({ kind: "perf" }));
		expect(out.ok).toBe(false);
		expect(out.error).toContain("url");
	});

	it("refuses an unknown kind, naming the known ones", async () => {
		const out = await runWebCheck(
			JSON.stringify({ kind: "vibes", url: "https://example.com" }),
		);
		expect(out.ok).toBe(false);
		for (const kind of WEB_CHECK_KINDS) {
			expect(out.error).toContain(kind);
		}
	});
});
