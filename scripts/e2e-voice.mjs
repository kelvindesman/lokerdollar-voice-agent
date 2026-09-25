#!/usr/bin/env node
/**
 * Scripted end-to-end voice test — no microphone needed.
 *
 * Synthesizes spoken prompts with macOS `say`, converts them to PCM16 24 kHz
 * mono with `afconvert`, then drives a REAL AssemblyAI Voice Agent session
 * through the deployed app exactly like the browser does:
 *
 *   GET  <BASE>/api/token              → single-use token
 *   wss://agents.assemblyai.com/v1/ws  → session.update (same config as the web app)
 *   stream audio in real time          → transcript.user, tool.call
 *   POST <BASE>/api/tools/<name>       → real LokerDollar jobs → tool.result
 *
 * Scenario: (1) ask for jobs, (2) "tell me more about the second one",
 * (3) barge in while the agent is talking.
 *
 * Usage: BASE=https://<worker>.workers.dev node scripts/e2e-voice.mjs
 * Needs Node 22+ (global WebSocket) and macOS (say, afconvert).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const OUT = join(fileURLToPath(new URL(".", import.meta.url)), ".out");
const RATE = 24_000;
const CHUNK = RATE * 0.05; // 50 ms of samples
const VOICE = process.env.SAY_VOICE ?? "Samantha";

mkdirSync(OUT, { recursive: true });

// ── build the session config from the web app source (single source of truth) ──
const { sessionUpdate } = await import("../web/src/agent-config.ts");

function synth(name, text) {
	const aiff = join(OUT, `${name}.aiff`);
	const wav = join(OUT, `${name}.wav`);
	execFileSync("say", ["-v", VOICE, "-r", "175", "-o", aiff, text]);
	execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", aiff, wav]);
	const buf = readFileSync(wav);
	const idx = buf.indexOf(Buffer.from("data"));
	const len = buf.readUInt32LE(idx + 4);
	return buf.subarray(idx + 8, idx + 8 + len);
}

const prompts = {
	search: synth("search", "Hi. Find me remote customer support jobs that pay in US dollars."),
	more: synth("more", "Tell me more about the second one."),
	barge: synth("barge", "Wait, stop. Show me React developer jobs instead."),
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const results = { toolCalls: [], userTranscripts: [], agentTranscripts: [], interrupted: 0, errors: [] };

// ── token ────────────────────────────────────────────────────────────────────
const tokRes = await fetch(`${BASE}/api/token`, { headers: { origin: BASE } });
const tok = await tokRes.json();
if (!tokRes.ok || !tok.token) {
	console.error("token failed", tokRes.status, tok);
	process.exit(1);
}
log("token ok");

const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(tok.token)}`);
let ready = false;
let lastEvent = null;
let pending = [];
let agentSpeaking = false;
const queue = []; // PCM buffers waiting to be streamed

function flushTools() {
	if (lastEvent !== "reply.done" || pending.length === 0) return;
	for (const p of pending) {
		if (process.env.DEBUG) log(">> tool.result", p.call_id, `${p.result.length} bytes`, p.result.slice(0, 200));
		ws.send(JSON.stringify({ type: "tool.result", ...p }));
	}
	log(`→ tool.result x${pending.length}`);
	pending = [];
}

const waiters = [];
function waitFor(pred, ms, label) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
		waiters.push({ pred, resolve: (v) => (clearTimeout(t), resolve(v)) });
	});
}
function emit(ev) {
	for (let i = waiters.length - 1; i >= 0; i--) {
		if (waiters[i].pred(ev)) waiters.splice(i, 1)[0].resolve(ev);
	}
}

ws.onopen = () => ws.send(JSON.stringify(sessionUpdate("en")));
ws.onmessage = async (m) => {
	const ev = JSON.parse(String(m.data));
	if (process.env.DEBUG && !["reply.audio", "transcript.agent.delta"].includes(ev.type)) {
		log("<<", ev.type, JSON.stringify(ev).slice(0, 300));
	}
	switch (ev.type) {
		case "session.ready":
			ready = true;
			log("session.ready", ev.session_id);
			break;
		case "transcript.user":
			results.userTranscripts.push(ev.text);
			log("USER:", ev.text);
			break;
		case "transcript.agent":
			results.agentTranscripts.push({ text: ev.text, interrupted: ev.interrupted });
			log(`AGENT${ev.interrupted ? " (interrupted)" : ""}:`, ev.text);
			break;
		case "reply.started":
			lastEvent = ev.type;
			agentSpeaking = true;
			break;
		case "input.speech.started":
			lastEvent = ev.type;
			log("speech.started");
			break;
		case "input.speech.stopped":
			log("speech.stopped");
			break;
		case "reply.done":
			lastEvent = ev.type;
			agentSpeaking = false;
			if (ev.status === "interrupted") {
				results.interrupted++;
				pending = [];
				log("reply.done interrupted");
			} else flushTools();
			break;
		case "tool.call": {
			lastEvent = ev.type; // wait for the reply.done that follows this call
			log("TOOL CALL:", ev.name, JSON.stringify(ev.arguments));
			const r = await fetch(`${BASE}/api/tools/${ev.name}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(ev.arguments ?? {}),
			});
			const body = await r.json();
			const summary =
				ev.name === "search_jobs"
					? {
							query: body.query,
							widened: body.widened,
							count: body.jobs?.length ?? 0,
							jobs: (body.jobs ?? []).map(({ url, applyUrl, payLabel, ...j }) => j),
							...(body.note ? { note: body.note } : {}),
						}
					: body.job
						? { ...body.job, url: undefined, applyUrl: undefined, applyButtonShownOnScreen: true }
						: { error: body.message ?? "not found" };
			results.toolCalls.push({ name: ev.name, args: ev.arguments, http: r.status, count: summary.count, first: summary.jobs?.[0]?.title ?? summary.title });
			pending.push({ call_id: ev.call_id, result: JSON.stringify(summary), is_error: !r.ok });
			flushTools();
			break;
		}
		case "session.error":
			results.errors.push(`${ev.code}: ${ev.message}`);
			log("session.error", ev.code, ev.message);
			break;
		case "session.ended":
			log("session.ended", ev.session_duration_seconds);
			break;
	}
	emit(ev);
};
ws.onclose = (e) => log("ws closed", e.code, e.reason);

// ── real-time audio pump: speech from the queue, silence otherwise ──────────
// Room tone instead of digital zeros: a real mic never sends exact silence,
// and pure zeros make end-of-turn detection erratic in this harness.
function roomTone() {
	const b = Buffer.alloc(CHUNK * 2);
	for (let i = 0; i < CHUNK; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 40), i * 2);
	return b;
}
let cur = null;
let off = 0;
const pump = setInterval(() => {
	if (!ready || ws.readyState !== WebSocket.OPEN) return;
	let chunk = roomTone();
	if (!cur && queue.length) {
		cur = queue.shift();
		off = 0;
	}
	if (cur) {
		chunk = Buffer.alloc(CHUNK * 2);
		cur.copy(chunk, 0, off, Math.min(off + CHUNK * 2, cur.length));
		off += CHUNK * 2;
		if (off >= cur.length) cur = null;
	}
	ws.send(JSON.stringify({ type: "input.audio", audio: chunk.toString("base64") }));
}, 50);

const say = (buf) => queue.push(buf);
const agentDone = (label, ms = 45_000) =>
	waitFor((e) => e.type === "reply.done" && e.status === "completed" && pending.length === 0 && lastEvent === "reply.done", ms, label);

try {
	await waitFor((e) => e.type === "session.ready", 15_000, "session.ready");
	await agentDone("greeting");
	log("── step 1: search");
	say(prompts.search);
	await waitFor((e) => e.type === "tool.call" && e.name === "search_jobs", 30_000, "search_jobs call");
	await waitFor((e) => e.type === "transcript.agent" && !e.interrupted, 45_000, "agent answer after search");
	await agentDone("search answer done");

	log("── step 2: tell me more");
	say(prompts.more);
	await waitFor((e) => e.type === "tool.call" && e.name === "get_job", 30_000, "get_job call");
	// barge in as soon as the agent starts speaking the details
	await waitFor((e) => e.type === "reply.audio", 30_000, "agent audio for details");
	await new Promise((r) => setTimeout(r, 1200));
	log("── step 3: barge-in");
	say(prompts.barge);
	await waitFor((e) => e.type === "reply.done" && e.status === "interrupted", 15_000, "interruption").catch((err) =>
		log("no interruption observed:", err.message),
	);
	await waitFor((e) => e.type === "tool.call" && e.name === "search_jobs", 30_000, "second search").catch((err) =>
		log(err.message),
	);
	await agentDone("final answer", 45_000).catch((err) => log(err.message));
} catch (err) {
	results.errors.push(String(err.message ?? err));
	log("FAILED:", err.message);
} finally {
	clearInterval(pump);
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "session.end" }));
	await new Promise((r) => setTimeout(r, 1500));
	try {
		ws.close();
	} catch {}
	console.log("\n=== RESULT ===");
	console.log(JSON.stringify(results, null, 2));
	const ok =
		results.toolCalls.some((c) => c.name === "search_jobs" && c.count > 0) &&
		results.toolCalls.some((c) => c.name === "get_job" && c.http === 200);
	console.log(ok ? "PASS: real jobs returned via voice + get_job follow-up" : "FAIL");
	process.exit(ok ? 0 : 1);
}
