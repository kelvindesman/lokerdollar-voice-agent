/**
 * LokerDollar Voice — Cloudflare Worker.
 *
 *   POST /api/chat               one Nemotron turn via Nebius Token Factory (tools run in the browser)
 *   GET  /api/token              mint a single-use AssemblyAI Voice Agent token (legacy engine)
 *   POST /api/tools/search_jobs  proxy → LokerDollar MCP `search_jobs`
 *   POST /api/tools/get_job      proxy → LokerDollar MCP `get_job`
 *   GET  /api/health             liveness + config check (no secrets)
 *   *                            static frontend (ASSETS)
 *
 * Provider keys never leave this Worker. The browser only ever sees model
 * output (Nemotron) or a short-lived, single-use token (AssemblyAI).
 */

import { type McpJob, monthlyUsdMax, toVoiceJob, type VoiceJob } from "../shared/jobs";
import { CHAT_TOOLS, chatSystemPrompt, type Lang } from "../shared/nemotron";

interface Env {
	ASSETS: Fetcher;
	ASSEMBLYAI_API_KEY?: string;
	NEBIUS_API_KEY?: string;
	NEMOTRON_MODEL?: string;
	LOKERDOLLAR_MCP_URL: string;
}

const TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
/** Fastest Nemotron on Token Factory with reliable tool calls (measured 2026-10-09: ~0.9 s to a tool call). */
const DEFAULT_NEMOTRON_MODEL = "nvidia/Nemotron-3_5-Lightning";
/** Conversation turns kept per request; older turns are dropped from the front. */
const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_CHARS = 24_000;

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

function limiter(max: number, windowMs: number) {
	const seen = new Map<string, number[]>();
	return (ip: string): boolean => {
		const now = Date.now();
		const hits = (seen.get(ip) ?? []).filter((t) => now - t < windowMs);
		if (hits.length >= max) {
			seen.set(ip, hits);
			return false;
		}
		hits.push(now);
		seen.set(ip, hits);
		if (seen.size > 5000) seen.clear();
		return true;
	};
}

const allowToken = limiter(8, 10 * 60_000);
/** A voice turn with tools is 2–3 model calls; 90 per 10 min is a long, busy conversation. */
const allowChat = limiter(90, 10 * 60_000);

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

type ChatMessage = {
	role: "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: unknown;
	tool_call_id?: string;
};

function sanitizeMessages(raw: unknown): ChatMessage[] | null {
	if (!Array.isArray(raw)) return null;
	const out: ChatMessage[] = [];
	for (const m of raw.slice(-MAX_CHAT_MESSAGES)) {
		if (!m || typeof m !== "object") return null;
		const { role, content, tool_calls, tool_call_id } = m as Record<string, unknown>;
		if (role !== "user" && role !== "assistant" && role !== "tool") return null;
		if (content != null && typeof content !== "string") return null;
		const msg: ChatMessage = { role, content: (content as string | null) ?? null };
		if (role === "assistant" && Array.isArray(tool_calls)) msg.tool_calls = tool_calls;
		if (role === "tool") {
			if (typeof tool_call_id !== "string") return null;
			msg.tool_call_id = tool_call_id;
		}
		out.push(msg);
	}
	// A tool message must follow the assistant turn that called it; drop orphans left by trimming.
	while (out.length && out[0]?.role !== "user") out.shift();
	if (JSON.stringify(out).length > MAX_CHAT_CHARS) return null;
	return out;
}

/**
 * One Nemotron turn. The browser owns the conversation and runs the tools
 * (so job cards render the moment results arrive); this route only adds the
 * system prompt, tool schemas, model choice, and the key.
 */
async function chat(request: Request, env: Env): Promise<Response> {
	if (!env.NEBIUS_API_KEY) {
		return json({ error: "server_not_configured", message: "NEBIUS_API_KEY is not set." }, 503);
	}
	if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (!allowChat(ip)) {
		return json({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." }, 429);
	}
	const body = ((await request.json().catch(() => null)) ?? {}) as { lang?: unknown; messages?: unknown };
	const lang: Lang = body.lang === "id" ? "id" : "en";
	const messages = sanitizeMessages(body.messages);
	if (!messages || messages.length === 0) return json({ error: "bad_request" }, 400);

	const model = env.NEMOTRON_MODEL || DEFAULT_NEMOTRON_MODEL;
	const started = Date.now();
	const res = await fetch(TOKEN_FACTORY_URL, {
		method: "POST",
		signal: AbortSignal.timeout(25_000),
		headers: {
			authorization: `Bearer ${env.NEBIUS_API_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model,
			temperature: 0.3,
			max_tokens: 400,
			tools: CHAT_TOOLS,
			messages: [{ role: "system", content: chatSystemPrompt(lang) }, ...messages],
		}),
	});
	if (!res.ok) {
		// Status only; the upstream body could echo request details.
		console.error(`nemotron_upstream ${res.status}`);
		return json({ error: "model_upstream", status: res.status }, 502);
	}
	const data = (await res.json()) as {
		choices?: { message?: { content?: string | null; tool_calls?: unknown } }[];
	};
	const msg = data.choices?.[0]?.message;
	return json({
		model,
		ms: Date.now() - started,
		content: msg?.content ?? null,
		tool_calls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : [],
	});
}

type SearchBody = {
	query?: unknown;
	remote_usd_only?: unknown;
	include_region_locked?: unknown;
	indonesia_friendly_only?: unknown;
	min_monthly_usd?: unknown;
};

export type SearchResponse = {
	query: string | null;
	usdOnly: boolean;
	indonesiaFriendlyOnly: boolean;
	minMonthlyUsd: number | null;
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
	const idOnly = body.indonesia_friendly_only === true;
	const minMonthly =
		typeof body.min_monthly_usd === "number" && body.min_monthly_usd > 0
			? Math.min(body.min_monthly_usd, 100_000)
			: 0;

	const cacheKey = `s|${query ?? ""}|${usdOnly}|${includeRegionLocked}|${idOnly}|${minMonthly}`;
	const cached = cacheGet(cacheKey);
	if (cached) return json(cached, 200, { "x-cache": "hit" });

	const run = async (usd: boolean) => {
		const out = (await callMcp(env, "search_jobs", {
			...(query ? { query } : {}),
			remote_usd_only: usd,
			include_region_locked: includeRegionLocked,
			...(idOnly ? { geo_verified_only: true } : {}),
		})) as { jobs?: McpJob[] } | undefined;
		const all = out?.jobs ?? [];
		if (!minMonthly) return all;
		return all.filter((j) => (monthlyUsdMax(j) ?? 0) >= minMonthly);
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
		indonesiaFriendlyOnly: idOnly,
		minMonthlyUsd: minMonthly || null,
		widened,
		total: rows.length,
		jobs,
	};
	if (jobs.length === 0 && (idOnly || minMonthly)) {
		result.note = `No active jobs matched with these filters${minMonthly ? ` (at least ${minMonthly} US dollars a month)` : ""}${idOnly ? " (confirmed open to Indonesia)" : ""}. Offer to drop a filter.`;
	} else if (jobs.length === 0) {
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
					nemotronConfigured: Boolean(env.NEBIUS_API_KEY),
					model: env.NEMOTRON_MODEL || DEFAULT_NEMOTRON_MODEL,
					jobSource: "lokerdollar-mcp",
				});
			}
			if (pathname === "/api/chat" && request.method === "POST") {
				return await chat(request, env);
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
