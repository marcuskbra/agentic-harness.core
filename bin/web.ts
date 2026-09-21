/**
 * The web check commands: one browser, one page, one verdict.
 *
 * This is the CLI adapter for the judgment checks a hook-and-skill
 * consumer cannot reach through a library import: it opens a
 * session, runs one check against one URL and answers JSON with
 * the same rendered report the pi tools show. Stateless per
 * invocation like every other command here; the browser lives and
 * dies inside the call.
 */

import { tallyFindings } from "../web/audit/index.js";
import { analyseMotion } from "../web/audit/motion.js";
import { renderAudit } from "../web/audit/report.js";
import {
	analyseTypography,
	renderTypography,
} from "../web/design/typography.js";
import { judgeHydration, renderHydration } from "../web/hydration/index.js";
import { measureSamples, renderVitals } from "../web/perf/index.js";
import type { Vitals } from "../web/perf/vitals.js";
import { BrowserSession } from "../web/session.js";

/** The checks this command knows how to run. */
export const WEB_CHECK_KINDS = [
	"motion",
	"typography",
	"hydration",
	"perf",
] as const;

type WebCheckKind = (typeof WEB_CHECK_KINDS)[number];

/** What arrives on stdin. */
export interface WebCheckInput {
	readonly kind: string;
	readonly url: string;
	/** For perf: how many loads to sample. Defaults to 3. */
	readonly samples?: number;
}

/** What goes out on stdout. */
export interface WebCheckOutput {
	readonly ok: boolean;
	readonly kind?: string;
	readonly url?: string;
	/** The same rendered verdict the pi tools show. */
	readonly report?: string;
	readonly error?: string;
}

/** Perf samples when the caller does not say. */
const DEFAULT_SAMPLES = 3;

/** The most loads one perf call will pay for. */
const MAX_SAMPLES = 9;

function isKind(kind: string): kind is WebCheckKind {
	return (WEB_CHECK_KINDS as readonly string[]).includes(kind);
}

async function checkOn(
	session: BrowserSession,
	kind: WebCheckKind,
	input: WebCheckInput,
): Promise<string> {
	if (kind === "perf") {
		const wanted = Math.min(
			Math.max(1, Math.round(input.samples ?? DEFAULT_SAMPLES)),
			MAX_SAMPLES,
		);
		const samples: Vitals[] = [await session.vitals()];
		while (samples.length < wanted) {
			const { failure } = await session.reload();
			// A reload that failed ends the sampling rather than the
			// check: the loads that did land are still a measurement.
			if (failure) break;
			samples.push(await session.vitals());
		}
		const last = samples[samples.length - 1] as Vitals;
		return renderVitals(last, measureSamples(samples));
	}

	if (kind === "motion") {
		const findings = analyseMotion(await session.motionUnderReduce());
		return renderAudit(findings, tallyFindings(findings), {
			measured:
				"Emulated prefers-reduced-motion: reduce, reloaded, and read " +
				"what was still moving.",
		});
	}

	if (kind === "typography") {
		const blocks = await session.typography();
		return renderTypography(blocks, analyseTypography(blocks));
	}

	const capture = await session.hydration();
	const lines = session
		.logs()
		.entries.map(({ item }) => ({ level: item.level, text: item.text }));
	return renderHydration(judgeHydration(capture, lines));
}

/** Run one web check against one URL. */
export async function runWebCheck(raw: string): Promise<WebCheckOutput> {
	let input: WebCheckInput;
	try {
		input = JSON.parse(raw) as WebCheckInput;
	} catch {
		return { ok: false, error: "stdin must be JSON: { kind, url }" };
	}
	if (!input.url) {
		return { ok: false, error: "url is required" };
	}
	if (!input.kind || !isKind(input.kind)) {
		return {
			ok: false,
			error: `kind must be one of: ${WEB_CHECK_KINDS.join(", ")}`,
		};
	}

	const session = await BrowserSession.open(`web-check-${process.pid}`);
	try {
		const { failure, status } = await session.navigate(input.url);
		if (failure) {
			return { ok: false, error: `Could not load ${input.url}: ${failure}` };
		}
		if (status !== undefined && status >= 400) {
			return { ok: false, error: `${input.url} answered ${status}` };
		}
		const report = await checkOn(session, input.kind, input);
		return { ok: true, kind: input.kind, url: input.url, report };
	} finally {
		await session.close();
	}
}
