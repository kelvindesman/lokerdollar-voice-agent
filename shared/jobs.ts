/**
 * Job shaping shared by the Worker (tool proxy) and the browser (cards).
 *
 * The LokerDollar anonymous MCP returns summary rows. We compact them into a
 * voice-friendly shape: a spoken pay phrase, an approximate monthly IDR figure
 * (the number an Indonesian worker actually compares against), and a rank the
 * user can refer to by voice ("the second one").
 */

/** Row as returned by LokerDollar MCP `search_jobs` / `get_job`. */
export type McpJob = {
	id: string;
	title: string;
	company: string | null;
	payMin: number | null;
	payMax: number | null;
	payCurrency: string | null;
	payPeriod: string | null;
	geoFit?: string | null;
	applicantRegion?: string | null;
	indonesiaEligibility?: "id_friendly" | "restricted" | "unknown" | string;
	freshnessTier?: string | null;
	url: string;
	applyUrl: string;
};

export type VoiceJob = {
	rank: number;
	id: string;
	title: string;
	company: string | null;
	/** Short phrase the agent can read aloud, e.g. "90 to 100 thousand US dollars a year". */
	paySpoken: string | null;
	/** Compact label for the card, e.g. "$90k–$100k / yr". */
	payLabel: string | null;
	/** Approximate monthly pay in IDR at USD_IDR_RATE, midpoint of the range. */
	payIdrMonthly: number | null;
	eligibility: "id_friendly" | "restricted" | "unknown";
	applicantRegion: string | null;
	freshness: string | null;
	url: string;
	applyUrl: string;
};

/**
 * Fixed, approximate conversion rate used only for an on-screen "≈ Rp" hint.
 * Deliberately a constant (no FX API call on the request path); the UI labels
 * it as approximate.
 */
export const USD_IDR_RATE = 16_500;

const PERIODS_PER_MONTH: Record<string, number> = {
	yearly: 1 / 12,
	annual: 1 / 12,
	monthly: 1,
	weekly: 52 / 12,
	daily: 22,
	hourly: 160,
};

const PERIOD_WORD: Record<string, string> = {
	yearly: "a year",
	annual: "a year",
	monthly: "a month",
	weekly: "a week",
	daily: "a day",
	hourly: "an hour",
};

const PERIOD_SHORT: Record<string, string> = {
	yearly: "yr",
	annual: "yr",
	monthly: "mo",
	weekly: "wk",
	daily: "day",
	hourly: "hr",
};

function compactUsd(n: number): string {
	if (n >= 1000) {
		const k = n / 1000;
		return `$${Number.isInteger(k) ? k : k.toFixed(1)}k`;
	}
	return `$${Math.round(n)}`;
}

function spokenAmount(n: number): string {
	if (n >= 1000) {
		const k = n / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)} thousand`;
	}
	return `${Math.round(n)}`;
}

function normalizeEligibility(v: unknown): VoiceJob["eligibility"] {
	return v === "id_friendly" || v === "restricted" ? v : "unknown";
}

export function toVoiceJob(job: McpJob, rank: number): VoiceJob {
	const min = job.payMin ?? null;
	const max = job.payMax ?? null;
	const currency = (job.payCurrency ?? "").toUpperCase();
	const period = (job.payPeriod ?? "").toLowerCase();
	const hasPay = (min ?? max) != null && currency === "USD";

	let paySpoken: string | null = null;
	let payLabel: string | null = null;
	let payIdrMonthly: number | null = null;

	if (hasPay) {
		const lo = min ?? max ?? 0;
		const hi = max ?? min ?? 0;
		const periodWord = PERIOD_WORD[period] ?? "";
		const periodShort = PERIOD_SHORT[period];
		payLabel =
			lo === hi
				? `${compactUsd(lo)}${periodShort ? ` / ${periodShort}` : ""}`
				: `${compactUsd(lo)}–${compactUsd(hi)}${periodShort ? ` / ${periodShort}` : ""}`;
		paySpoken =
			lo === hi
				? `${spokenAmount(lo)} US dollars ${periodWord}`.trim()
				: `${spokenAmount(lo)} to ${spokenAmount(hi)} US dollars ${periodWord}`.trim();
		const perMonth = PERIODS_PER_MONTH[period];
		if (perMonth) {
			const mid = (lo + hi) / 2;
			payIdrMonthly =
				Math.round((mid * perMonth * USD_IDR_RATE) / 100_000) * 100_000;
		}
	}

	return {
		rank,
		id: job.id,
		title: job.title,
		company: job.company,
		paySpoken,
		payLabel,
		payIdrMonthly,
		eligibility: normalizeEligibility(job.indonesiaEligibility),
		applicantRegion: job.applicantRegion ?? null,
		freshness: job.freshnessTier ?? null,
		url: job.url,
		applyUrl: job.applyUrl,
	};
}

/** "Rp 137 juta / bulan" style label. */
export function formatIdrMonthly(n: number, lang: "en" | "id"): string {
	if (n >= 1_000_000_000) {
		const v = (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "");
		return lang === "id" ? `≈ Rp ${v} miliar/bln` : `≈ Rp ${v}B / month`;
	}
	const v = Math.round(n / 1_000_000);
	return lang === "id" ? `≈ Rp ${v} juta/bln` : `≈ Rp ${v}M / month`;
}
