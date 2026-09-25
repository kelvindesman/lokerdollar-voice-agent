/**
 * LokerDollar Voice — Cloudflare Worker.
 *
 *   GET  /api/token              mint a single-use AssemblyAI Voice Agent token
 *   POST /api/tools/search_jobs  proxy → LokerDollar MCP `search_jobs`
 *   POST /api/tools/get_job      proxy → LokerDollar MCP `get_job`
 *   GET  /api/health             liveness + config check (no secrets)
 *   *                            static frontend (ASSETS)
 *
 * The AssemblyAI API key never leaves this Worker. The browser only ever sees
 * a short-lived, single-use token.
 */

import { type McpJob, toVoiceJob, type VoiceJob } from "../shared/jobs";

interface Env {
	ASSETS: Fetcher;
	ASSEMBLYAI_API_KEY?: string;
	LOKERDOLLAR_MCP_URL: string;
}

const AAI_TOKEN_URL = "https://agents.assemblyai.com/v1/token";
/** Token redemption window: the browser opens the socket right after minting. */
const TOKEN_TTL_SECONDS = 60;
/** Hard cap on one voice session. Keeps a public demo's spend bounded. */
const MAX_SESSION_SECONDS = 600;
/** Max jobs returned to the agent + UI per search. */
const MAX_RESULTS = 6;
/** applicant_region values an Indonesia-based applicant can still take. */
const OPEN_REGIONS = /worldwide|global|anywhere|apac|asia|indonesia|sea/i;

// ── tiny per-isolate guards (no KV/D1 by design) ─────────────────────────────

const tokenHits = new Map<string, number[]>();
function allowToken(ip: string): boolean {
	const now = Date.now();
	const windowMs = 10 * 60_000;
	const hits = (tokenHits.get(ip) ?? []).filter((t) => now - t < windowMs);
	if (hits.length >= 8) {
		tokenHits.set(ip, hits);
		return false;
	}
	hits.push(now);
	tokenHits.set(ip, hits);
	if (tokenHits.size > 5000) tokenHits.clear();
	return true;
}

type CacheEntry = { at: number; body: unknown };
const toolCache = new Map<string, CacheEntry>();
const TOOL_CACHE_MS = 5 * 60_000;

function cacheGet(key: string): unknown | undefined {
	const hit = toolCache.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > TOOL_CACHE_MS) {
		toolCache.delete(key);
		return undefined;
	}
	return hit.body;
}

function cachePut(key: string, body: unknown): void {
	if (toolCache.size > 500) toolCache.clear();
	toolCache.set(key, { at: Date.now(), body });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...extra,
		},
	});
}

/** Reject cross-site callers of the token endpoint (a browser always sends Origin/Referer). */
function sameOrigin(request: Request): boolean {
	const self = new URL(request.url).host;
	const origin =
		request.headers.get("origin") ?? request.headers.get("referer");
	if (!origin) return false;
	try {
		return new URL(origin).host === self;
	} catch {
		return false;
	}
}

let rpcId = 0;
async function callMcp(
	env: Env,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await fetch(env.LOKERDOLLAR_MCP_URL, {
		method: "POST",
		signal: AbortSignal.timeout(15_000),
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			"user-agent":
				"lokerdollar-voice-agent/0.1 (+https://github.com/kelvindesman/lokerdollar-voice-agent)",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++rpcId,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	if (!res.ok) {
		throw new Error(`LokerDollar MCP HTTP ${res.status}`);
	}
	const data = (await res.json()) as {
		result?: {
			structuredContent?: unknown;
			isError?: boolean;
			content?: { text?: string }[];
		};
		error?: { message?: string };
	};
	if (data.error)
		throw new Error(
			`LokerDollar MCP error: ${data.error.message ?? "unknown"}`,
		);
	if (data.result?.isError) {
		throw new Error(
			data.result.content?.[0]?.text ?? "LokerDollar MCP tool error",
		);
	}
	return data.result?.structuredContent;
}

function str(v: unknown, max = 80): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim().slice(0, max);
	return t.length ? t : undefined;
}

// ── routes ───────────────────────────────────────────────────────────────────

async function mintToken(request: Request, env: Env): Promise<Response> {
	if (!env.ASSEMBLYAI_API_KEY) {
		return json(
			{
				error: "server_not_configured",
				message: "ASSEMBLYAI_API_KEY is not set.",
			},
			503,
		);
	}
	if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (!allowToken(ip)) {
		return json(
			{
				error: "rate_limited",
				message: "Too many sessions. Try again in a few minutes.",
			},
			429,
		);
	}
	const url = new URL(AAI_TOKEN_URL);
	url.searchParams.set("expires_in_seconds", String(TOKEN_TTL_SECONDS));
	url.searchParams.set(
		"max_session_duration_seconds",
		String(MAX_SESSION_SECONDS),
	);
	// Docs show both "Bearer <key>" (token endpoint) and a bare key (REST); try both.
	let res = await fetch(url, {
		headers: { Authorization: `Bearer ${env.ASSEMBLYAI_API_KEY}` },
	});
	if (res.status === 401) {
		res = await fetch(url, {
			headers: { Authorization: env.ASSEMBLYAI_API_KEY },
		});
	}
	if (!res.ok) {
		// Status only; the body could echo request details.
		return json({ error: "token_upstream", status: res.status }, 502);
	}
	const { token } = (await res.json()) as { token?: string };
	if (!token) return json({ error: "token_upstream", status: 502 }, 502);
	return json({ token, maxSessionSeconds: MAX_SESSION_SECONDS });
}

type SearchBody = {
	query?: unknown;
	remote_usd_only?: unknown;
	include_region_locked?: unknown;
};

export type SearchResponse = {
	query: string | null;
	usdOnly: boolean;
	/** True when the USD-only filter returned nothing and we widened the search. */
	widened: boolean;
	total: number;
	jobs: VoiceJob[];
	note?: string;
};

async function searchJobs(request: Request, env: Env): Promise<Response> {
	const body = ((await request.json().catch(() => ({}))) ?? {}) as SearchBody;
	const query = str(body.query);
	const usdOnly = body.remote_usd_only !== false; // default ON: this is a dollar-job agent
	const includeRegionLocked = body.include_region_locked === true;

	const cacheKey = `s|${query ?? ""}|${usdOnly}|${includeRegionLocked}`;
	const cached = cacheGet(cacheKey);
	if (cached) return json(cached, 200, { "x-cache": "hit" });

	const run = async (usd: boolean) => {
		const out = (await callMcp(env, "search_jobs", {
			...(query ? { query } : {}),
			remote_usd_only: usd,
			include_region_locked: includeRegionLocked,
		})) as { jobs?: McpJob[] } | undefined;
		return out?.jobs ?? [];
	};

	let rows = await run(usdOnly);
	let widened = false;
	if (rows.length === 0 && usdOnly) {
		rows = await run(false);
		widened = rows.length > 0;
	}

	// Prefer rows with a stated salary, then Indonesia-friendly rows; keep source order otherwise.
	const scored = rows.map((r, i) => ({
		r,
		i,
		s:
			(r.payMin != null || r.payMax != null ? 2 : 0) +
			(r.indonesiaEligibility === "id_friendly" ? 1 : 0) -
			(r.applicantRegion && !OPEN_REGIONS.test(r.applicantRegion) ? 3 : 0),
	}));
	scored.sort((a, b) => b.s - a.s || a.i - b.i);
	const jobs = scored
		.slice(0, MAX_RESULTS)
		.map(({ r }, i) => toVoiceJob(r, i + 1));

	const result: SearchResponse = {
		query: query ?? null,
		usdOnly,
		widened,
		total: rows.length,
		jobs,
	};
	if (jobs.length === 0) {
		result.note = query
			? `No active jobs matched "${query}". The search matches job titles and company names, so try a shorter, more general English role keyword (e.g. "developer", "support", "designer", "writer", "marketing").`
			: "No active jobs found right now.";
	} else if (widened) {
		result.note =
			"No USD-salaried matches; these results do not state a USD salary.";
	}
	cachePut(cacheKey, result);
	return json(result);
}

async function getJob(request: Request, env: Env): Promise<Response> {
	const body = ((await request.json().catch(() => ({}))) ?? {}) as {
		job_id?: unknown;
	};
	const jobId = str(body.job_id, 200);
	if (!jobId) return json({ error: "job_id is required" }, 400);

	const cacheKey = `j|${jobId}`;
	const cached = cacheGet(cacheKey);
	if (cached) return json(cached, 200, { "x-cache": "hit" });

	try {
		const out = (await callMcp(env, "get_job", {
			job_id: jobId,
			include_region_locked: true,
		})) as { job?: McpJob } | McpJob | undefined;
		const row = out && "job" in out ? out.job : (out as McpJob | undefined);
		if (!row?.id)
			return json(
				{ error: "not_found", message: "That job is no longer active." },
				404,
			);
		const result = { job: toVoiceJob(row, 0) };
		cachePut(cacheKey, result);
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/not found|no longer/i.test(msg)) {
			return json(
				{ error: "not_found", message: "That job is no longer active." },
				404,
			);
		}
		throw err;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		try {
			if (pathname === "/api/health") {
				return json({
					ok: true,
					assemblyaiConfigured: Boolean(env.ASSEMBLYAI_API_KEY),
					jobSource: "lokerdollar-mcp",
				});
			}
			if (pathname === "/api/token" && request.method === "GET") {
				return await mintToken(request, env);
			}
			if (pathname === "/api/tools/search_jobs" && request.method === "POST") {
				return await searchJobs(request, env);
			}
			if (pathname === "/api/tools/get_job" && request.method === "POST") {
				return await getJob(request, env);
			}
			if (pathname.startsWith("/api/")) {
				return json({ error: "not_found" }, 404);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`api_error ${pathname}: ${msg}`);
			return json(
				{
					error: "upstream_error",
					message: "Job search is temporarily unavailable.",
				},
				502,
			);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
