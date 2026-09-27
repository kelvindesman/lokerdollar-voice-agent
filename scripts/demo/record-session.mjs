#!/usr/bin/env node
/**
 * Demo video, pass 1: run ONE real AssemblyAI Voice Agent session and log it.
 *
 * Uses the deployed Worker exactly like the web app does (token + tools) and the
 * app's own session config (web/src/agent-config.ts). The "user" is a scripted
 * microphone streaming pre-rendered speech in real time; cues react to what the
 * agent does (barge in when job #3 is actually being spoken, etc.).
 *
 * Writes to <outDir>:
 *   session.json  every server event with a timestamp (ms, relative to socket open),
 *                 the raw Worker tool responses, and the user clip timings
 *   user.wav      exactly the audio streamed as the microphone (24 kHz mono)
 *   agent.wav     the agent's speech, placed the way the web client plays it
 *                 (queued back to back, flushed on barge-in)
 *
 * Usage: node scripts/demo/record-session.mjs <appUrl> <clipsDir> <outDir>
 *        clipsDir: q1.wav q2.wav q3.wav, PCM16 mono 24 kHz
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [BASE_RAW, clipsDir, outDir] = process.argv.slice(2);
if (!BASE_RAW || !clipsDir || !outDir) {
	console.error("usage: record-session.mjs <appUrl> <clipsDir> <outDir>");
	process.exit(2);
}
const BASE = BASE_RAW.replace(/\/$/, "");
mkdirSync(outDir, { recursive: true });
const { sessionUpdate } = await import("../../web/src/agent-config.ts");

const RATE = 24_000;
const CHUNK = RATE * 0.05; // samples per 50 ms

function readPcm(file) {
	const buf = readFileSync(file);
	const fmt = buf.indexOf(Buffer.from("fmt "));
	const rate = buf.readUInt32LE(fmt + 12);
	if (rate !== RATE) throw new Error(`${file}: expected ${RATE} Hz, got ${rate}`);
	const d = buf.indexOf(Buffer.from("data"));
	return buf.subarray(d + 8, d + 8 + buf.readUInt32LE(d + 4));
}
const CLIPS = {
	q1: { pcm: readPcm(join(clipsDir, "q1.wav")), text: "Find me remote customer support jobs that pay in US dollars." },
	q2: { pcm: readPcm(join(clipsDir, "q2.wav")), text: "Wait, wait. Tell me more about the second one." },
	q3: { pcm: readPcm(join(clipsDir, "q3.wav")), text: "Now show me React developer jobs." },
};

const now = () => performance.timeOrigin + performance.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ── token + socket ───────────────────────────────────────────────────────────
const tokRes = await fetch(`${BASE}/api/token`, { headers: { origin: BASE } });
const tok = await tokRes.json();
if (!tok.token) {
	console.error("token failed", tokRes.status, tok);
	process.exit(1);
}
const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(tok.token)}`);
let T0 = null; // socket open, the zero of every timeline
const rel = () => now() - T0;

const events = []; // {t, ev} (reply.audio stored without payload)
const agentChunks = []; // {t, b64}
const toolResponses = []; // {t, name, args, status, body}
const clips = []; // {name, t, duration, text}
const userPcm = []; // Buffers exactly as streamed

// ── scripted microphone: room tone + clips, paced at real time ──────────────
function roomTone() {
	const b = Buffer.alloc(CHUNK * 2);
	for (let i = 0; i < CHUNK; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * 40), i * 2);
	return b;
}
let ready = false;
let cur = null;
let off = 0;
let sent = 0; // chunks sent
let pumpStart = null;
const queue = [];
function pumpOnce() {
	let chunk = roomTone();
	if (!cur && queue.length) {
		cur = queue.shift();
		off = 0;
	}
	if (cur) {
		const n = Math.min(CHUNK * 2, cur.length - off);
		cur.copy(chunk, 0, off, off + n);
		off += CHUNK * 2;
		if (off >= cur.length) cur = null;
	}
	userPcm.push(chunk);
	ws.send(JSON.stringify({ type: "input.audio", audio: chunk.toString("base64") }));
}
// Drift-free pacing: send however many chunks real time says we owe.
const pump = setInterval(() => {
	if (!ready || ws.readyState !== WebSocket.OPEN) return;
	if (pumpStart === null) pumpStart = now();
	const owed = Math.floor((now() - pumpStart) / 50) + 1;
	while (sent < owed) {
		pumpOnce();
		sent++;
	}
}, 10);
function play(name) {
	// Clip starts at the next chunk boundary.
	const t = pumpStart === null ? rel() : pumpStart - T0 + sent * 50;
	queue.push(CLIPS[name].pcm);
	clips.push({ name, t, duration: CLIPS[name].pcm.length / 2 / RATE, text: CLIPS[name].text });
	log(`USER ${name}: ${CLIPS[name].text}`);
}

// ── tools: same shaping as web/src/main.ts ───────────────────────────────────
let lastJobs = [];
const forModel = (j) => ({
	rank: j.rank,
	id: j.id,
	title: j.title,
	company: j.company,
	paySpoken: j.paySpoken,
	payIdrMonthly: j.payIdrMonthly,
	eligibility: j.eligibility,
	applicantRegion: j.applicantRegion,
	freshness: j.freshness,
});
async function runTool(name, args) {
	if (name === "search_jobs") {
		const body = { query: typeof args.query === "string" ? args.query : "", remote_usd_only: args.remote_usd_only !== false };
		const r = await fetch(`${BASE}/api/tools/search_jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const data = await r.json();
		toolResponses.push({ t: rel(), name, request: body, status: r.status, body: data });
		lastJobs = data.jobs ?? [];
		return { query: data.query, widened: data.widened, count: lastJobs.length, jobs: lastJobs.map(forModel), ...(data.note ? { note: data.note } : {}) };
	}
	if (name === "get_job") {
		const known = lastJobs.find((j) => j.id === args.job_id);
		if (known) return { ...forModel(known), applyButtonShownOnScreen: true };
		return { error: `No job with id "${args.job_id}" is active.` };
	}
	return { error: `Unknown tool ${name}.` };
}

// ── event loop + cues (mirrors the web client's tool-result gating) ──────────
let lastEvent = null;
let pending = [];
const cue = { phase: "greeting", audioStart: undefined };
let finished = false;
function flushTools() {
	if (lastEvent !== "reply.done" || pending.length === 0 || ws.readyState !== WebSocket.OPEN) return;
	for (const p of pending) ws.send(JSON.stringify({ type: "tool.result", ...p }));
	pending = [];
}
const later = (ms, fn) => setTimeout(fn, ms);

ws.onopen = () => {
	T0 = now();
	ws.send(JSON.stringify(sessionUpdate("en")));
};
ws.onmessage = async (m) => {
	const ev = JSON.parse(String(m.data));
	const t = rel();
	if (ev.type === "reply.audio") {
		agentChunks.push({ t, b64: ev.data });
		if (cue.phase === "reading1" && cue.audioStart === null) cue.audioStart = t;
		events.push({ t, ev: { type: "reply.audio", n: agentChunks.length - 1 } });
		return;
	}
	events.push({ t, ev });
	switch (ev.type) {
		case "session.ready":
			ready = true;
			log("session.ready", ev.session_id);
			break;
		case "reply.started":
		case "input.speech.started":
			lastEvent = ev.type;
			break;
		case "reply.done":
			lastEvent = ev.type;
			if (ev.status === "interrupted") {
				pending = [];
				log("interrupted");
			} else flushTools();
			break;
		case "tool.call": {
			lastEvent = ev.type;
			log("TOOL", ev.name, JSON.stringify(ev.arguments));
			let result;
			let isError = false;
			try {
				result = await runTool(ev.name, ev.arguments ?? {});
			} catch (err) {
				isError = true;
				result = { error: String(err) };
			}
			pending.push({ call_id: ev.call_id, result: JSON.stringify(result), is_error: isError });
			flushTools();
			break;
		}
		case "transcript.user":
			log("USER heard:", ev.text);
			break;
		case "transcript.agent":
			log(`AGENT${ev.interrupted ? " (interrupted)" : ""}:`, ev.text);
			break;
		case "session.error":
			log("session.error", ev.code, ev.message);
			break;
	}
	// cues
	if (cue.phase === "greeting" && ev.type === "transcript.agent") {
		cue.phase = "q1";
		later(1200, () => play("q1"));
	} else if (cue.phase === "q1" && ev.type === "tool.call" && ev.name === "search_jobs") {
		cue.phase = "reading1";
	} else if (cue.phase === "reading1" && ev.type === "reply.started") {
		cue.audioStart = null;
	} else if (cue.phase === "reading1" && ev.type === "transcript.agent.delta" && /^(three|3)[.,]?$/i.test(String(ev.delta).trim())) {
		cue.phase = "q2";
		// Deltas arrive ahead of playback: wait until "three" is actually heard.
		const heardAt = (cue.audioStart ?? t) + (Number(ev.start_ms) || 0);
		later(Math.max(0, heardAt - rel()) + 900, () => play("q2"));
	} else if (cue.phase === "q2" && ev.type === "tool.call" && ev.name === "get_job") {
		cue.phase = "details";
	} else if (cue.phase === "details" && ev.type === "transcript.agent" && !ev.interrupted) {
		cue.phase = "q3";
		later(1200, () => play("q3"));
	} else if (cue.phase === "q3" && ev.type === "tool.call" && ev.name === "search_jobs") {
		cue.phase = "reading3";
	} else if (cue.phase === "reading3" && ev.type === "transcript.agent" && !ev.interrupted) {
		cue.phase = "done";
		later(1500, () => (finished = true));
	}
};
ws.onclose = (e) => log("ws closed", e.code);

const deadline = Date.now() + 240_000;
while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
const endT = rel();
clearInterval(pump);
if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "session.end" }));
await new Promise((r) => setTimeout(r, 1200));
try {
	ws.close();
} catch {}

// ── write outputs ────────────────────────────────────────────────────────────
function wav(pcm, rate) {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcm.length, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * 2, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([h, pcm]);
}

// user.wav: silence until the pump started, then exactly what was streamed.
const lead = Buffer.alloc(Math.round(((pumpStart - T0) / 1000) * RATE) * 2);
writeFileSync(join(outDir, "user.wav"), wav(Buffer.concat([lead, ...userPcm]), RATE));

// agent.wav: place chunks like the client (playhead = max(playhead, arrival + 30 ms)),
// and cut everything past an interruption.
const totalSamples = Math.ceil((endT / 1000 + 5) * RATE);
const agent = new Int16Array(totalSamples);
let playhead = 0; // seconds
const interrupts = events.filter((e) => e.ev.type === "reply.done" && e.ev.status === "interrupted").map((e) => e.t / 1000);
let nextCut = 0;
const cutAt = [];
function cut(at) {
	// The client flushed everything still queued at the barge-in: silence it now,
	// before later replies are placed.
	cutAt.push([at, playhead]);
	for (let s = Math.round(at * RATE); s < Math.round(playhead * RATE) && s < agent.length; s++) agent[s] = 0;
	playhead = at;
}
for (const { t, b64 } of agentChunks) {
	const at = t / 1000;
	while (nextCut < interrupts.length && interrupts[nextCut] <= at) cut(interrupts[nextCut++]);
	const pcm = Buffer.from(b64, "base64");
	const start = Math.max(playhead, at + 0.03);
	const s0 = Math.round(start * RATE);
	for (let i = 0; i < pcm.length / 2 && s0 + i < agent.length; i++) agent[s0 + i] = pcm.readInt16LE(i * 2);
	playhead = start + pcm.length / 2 / RATE;
}
while (nextCut < interrupts.length) cut(interrupts[nextCut++]);
writeFileSync(join(outDir, "agent.wav"), wav(Buffer.from(agent.buffer), RATE));

writeFileSync(
	join(outDir, "session.json"),
	JSON.stringify({ endT, events, agentChunks, toolResponses, clips, interrupts: cutAt }, null, 0),
);
const ok = toolResponses.some((r) => r.name === "search_jobs" && (r.body.jobs?.length ?? 0) > 0) && interrupts.length > 0 && cue.phase === "done";
log(`done: phase=${cue.phase} tools=${toolResponses.length} interrupts=${interrupts.length} length=${(endT / 1000).toFixed(1)}s ok=${ok}`);
process.exit(ok ? 0 : 1);
