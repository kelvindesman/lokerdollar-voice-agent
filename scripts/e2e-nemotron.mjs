#!/usr/bin/env node
/**
 * Text-level end-to-end test of the Nemotron agent loop, without a browser.
 *
 * Runs the same loop as web/src/nemotron-client.ts against a live Worker:
 * POST /api/chat, execute tool calls via /api/tools/*, feed results back, and
 * check that each scripted turn calls the expected tool and gets a spoken reply.
 *
 *   BASE=http://localhost:8787 node scripts/e2e-nemotron.mjs
 *   BASE=https://lokerdollar-voice-agent.kelvin-6d2.workers.dev node scripts/e2e-nemotron.mjs
 */

const BASE = process.env.BASE ?? "http://localhost:8787";
const headers = { "content-type": "application/json", origin: BASE };

const SCRIPTS = {
	id: [
		{ say: "cari kerja customer support remote yang bayar dolar dong", expect: "search_jobs" },
		{ say: "ceritain yang nomor dua", expect: "get_job" },
		{ say: "perusahaan itu beneran nggak sih? bukan penipuan kan?", expect: "company_check" },
		{ say: "ada yang gajinya minimal 2000 dolar sebulan dan pasti bisa dari Indonesia? buat developer", expect: "search_jobs", args: (a) => a.min_monthly_usd >= 1500 },
	],
	en: [
		{ say: "Find me remote React jobs that pay in dollars", expect: "search_jobs" },
		{ say: "Tell me more about the first one", expect: "get_job" },
		{ say: "Is that company legit? What do they do?", expect: "company_check" },
	],
};

let lastJobs = [];

/** Mirrors forModel() in web/src/main.ts. */
function forModel({ url, applyUrl, payLabel, payIdrMonthly, ...j }) {
	return { ...j, payIdrMonthlyMillions: payIdrMonthly ? Math.round(payIdrMonthly / 1_000_000) : null };
}

async function post(path, body) {
	const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok && res.status !== 404) throw new Error(`${path} HTTP ${res.status} ${JSON.stringify(data)}`);
	return data;
}

async function runTool(name, args) {
	if (name === "search_jobs") {
		const r = await post("/api/tools/search_jobs", args);
		lastJobs = r.jobs ?? [];
		return {
			query: r.query,
			widened: r.widened,
			count: lastJobs.length,
			jobs: lastJobs.slice(0, 3).map(forModel),
			moreOnScreen: lastJobs.slice(3).map((j) => ({ rank: j.rank, id: j.id, title: j.title, company: j.company })),
			...(r.note ? { note: r.note } : {}),
		};
	}
	if (name === "get_job") {
		const j = lastJobs.find((x) => x.id === args.job_id);
		if (!j) return { error: `No job with id "${args.job_id}" in the latest results.` };
		return { ...forModel(j), applyButtonShownOnScreen: true };
	}
	if (name === "company_check") {
		const r = await post("/api/tools/company_check", args);
		if (r.error || !r.sources) return { error: `Could not look up ${args.company} right now.` };
		return {
			company: r.company,
			summary: r.summary,
			sources: r.sources.map(({ site, title, snippet }) => ({ site, title, snippet })),
			sourcesShownOnScreen: r.sources.length > 0,
		};
	}
	return { error: `Unknown tool ${name}` };
}

let failures = 0;
for (const [lang, turns] of Object.entries(SCRIPTS)) {
	const history = [];
	lastJobs = [];
	console.log(`\n=== ${lang} ===`);
	for (const t of turns) {
		history.push({ role: "user", content: t.say });
		const called = [];
		let answer = null;
		const t0 = Date.now();
		let firstMs = null;
		for (let hop = 0; hop < 4 && answer === null; hop++) {
			const r = await post("/api/chat", { lang, messages: history });
			firstMs ??= r.ms;
			if (!r.tool_calls?.length) {
				answer = r.content ?? "";
				history.push({ role: "assistant", content: answer });
				break;
			}
			history.push({ role: "assistant", content: r.content ?? null, tool_calls: r.tool_calls });
			for (const c of r.tool_calls) {
				const args = JSON.parse(c.function.arguments || "{}");
				called.push({ name: c.function.name, args });
				history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(await runTool(c.function.name, args)) });
			}
		}
		const hit = called.find((c) => c.name === t.expect);
		const argsOk = !t.args || (hit && t.args(hit.args));
		const ok = Boolean(hit) && argsOk && Boolean(answer);
		if (!ok) failures++;
		console.log(`${ok ? "PASS" : "FAIL"} "${t.say}"`);
		console.log(`  tools: ${called.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "none"}`);
		console.log(`  first model call ${firstMs} ms, whole turn ${Date.now() - t0} ms`);
		console.log(`  reply: ${answer}`);
	}
}
console.log(failures ? `\n${failures} turn(s) failed` : "\nall turns passed");
process.exit(failures ? 1 : 0);
