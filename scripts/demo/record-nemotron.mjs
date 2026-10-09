#!/usr/bin/env node
/**
 * Demo video (Nemotron build), pass 1: record one live Bahasa session.
 *
 * Everything the judges see and hear runs live against the deployed Worker:
 * Nemotron on Nebius Token Factory, the job tools, the Tavily company check,
 * and the Supertonic voice. One edge is scripted: speech recognition. Chrome's
 * Web Speech service does not accept a fake microphone, so the user's lines
 * are delivered to the page as recognition results (interim words, then the
 * final sentence) at the pace of a pre-synthesized clip of the same line.
 * The clips are mixed into the soundtrack at the moment they were "spoken".
 *
 * Captured to <outDir>:
 *   frames/NNNNN.jpg + frames.json   CDP screencast with epoch timestamps
 *   agent/<id>.wav                   every audio buffer the page played
 *   user/uN.wav                      the user's lines
 *   events.json                      audio starts/stops, user lines, TTS texts, chat replies
 *
 * Usage: node scripts/demo/record-nemotron.mjs <appUrl> <outDir>
 * Env: CHROME_PATH, PW_FROM (a package.json whose node_modules has @playwright/test), ZOOM (1.2)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [BASE_RAW, outDir] = process.argv.slice(2);
if (!BASE_RAW || !outDir) {
	console.error("usage: record-nemotron.mjs <appUrl> <outDir>");
	process.exit(2);
}
const BASE = BASE_RAW.replace(/\/$/, "");
for (const d of ["frames", "agent", "user"]) mkdirSync(join(outDir, d), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const require = createRequire(process.env.PW_FROM ?? `${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

/** The user's side of the conversation. `interruptAfterMs`: tap the orb that long into the agent's reply, then speak. */
const SCRIPT = [
	{ text: "Cari kerja customer support remote yang bayar dolar dong." },
	{ text: "Yang nomor dua, perusahaannya beneran nggak? Bukan penipuan kan?" },
	{ text: "Kalau developer, ada yang gajinya minimal dua ribu dolar sebulan, dan pasti bisa dari Indonesia?" },
	{ text: "Oke stop, yang nomor satu aja. Gajinya berapa rupiah?", interruptAfterMs: 6500 },
];

const headers = { "content-type": "application/json", referer: `${BASE}/` };
const events = { user: [], audio: [], stops: [], tts: [], chat: [], marks: {} };

// ── 1. warm the voice container, synthesize the user's lines ─────────────────
for (let i = 0; ; i++) {
	const r = await (await fetch(`${BASE}/api/tts`, { headers })).json().catch(() => ({}));
	if (r.ready) break;
	if (i > 40) throw new Error("TTS container never became ready");
	log("waiting for TTS container…");
	await sleep(5000);
}
function wavSeconds(buf) {
	const fmt = buf.indexOf(Buffer.from("fmt "));
	const data = buf.indexOf(Buffer.from("data"));
	const rate = buf.readUInt32LE(fmt + 12);
	const bytesPerSample = buf.readUInt16LE(fmt + 22) / 8;
	return buf.readUInt32LE(data + 4) / bytesPerSample / rate;
}
for (const [i, line] of SCRIPT.entries()) {
	const res = await fetch(`${BASE}/api/tts`, {
		method: "POST",
		headers,
		body: JSON.stringify({ text: line.text, lang: "id", voice: "M2", speed: 1.0 }),
	});
	if (!res.ok) throw new Error(`user line ${i + 1}: TTS HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	line.file = `user/u${i + 1}.wav`;
	line.seconds = wavSeconds(buf);
	writeFileSync(join(outDir, line.file), buf);
	log(`user line ${i + 1}: ${line.seconds.toFixed(1)} s`);
}

// ── 2. browser with recognition + audio hooks ────────────────────────────────
const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
	args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
	// 1920x1080 frames; the page is zoomed (below) so text reads well on video.
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
	permissions: ["microphone"],
	locale: "id-ID",
});
await context.exposeBinding("__rec", (_src, kind, payload) => {
	if (kind === "audio") {
		const pcm = Buffer.from(payload.pcm, "base64");
		const file = `agent/${payload.id}.wav`;
		writeFileSync(join(outDir, file), wav(pcm, payload.sr));
		events.audio.push({ id: payload.id, at: payload.at, seconds: payload.seconds, text: payload.text, file });
	} else if (kind === "stop") events.stops.push(payload);
	else if (kind === "tts") events.tts.push(payload);
});
await context.addInitScript(() => {
	// Recognition: results are pushed by window.__say from the recorder.
	const live = new Set();
	class ScriptedRecognition {
		lang = "en-US";
		continuous = false;
		interimResults = false;
		onresult = null;
		onerror = null;
		onend = null;
		onstart = null;
		active = false;
		start() {
			if (this.active) throw new DOMException("already started", "InvalidStateError");
			this.active = true;
			live.add(this);
			setTimeout(() => this.onstart?.(), 0);
		}
		stop() {
			this.#end();
		}
		abort() {
			this.#end();
		}
		#end() {
			if (!this.active) return;
			this.active = false;
			live.delete(this);
			setTimeout(() => this.onend?.(), 0);
		}
	}
	window.SpeechRecognition = ScriptedRecognition;
	window.webkitSpeechRecognition = ScriptedRecognition;
	const result = (t, isFinal) => Object.assign([{ transcript: t, confidence: 0.95 }], { isFinal });
	window.__say = (text, ms) => {
		const words = text.split(/\s+/);
		words.forEach((_, i) => {
			const last = i === words.length - 1;
			setTimeout(
				() => {
					const t = words.slice(0, i + 1).join(" ");
					for (const r of live) r.onresult?.({ resultIndex: 0, results: [result(t, last)] });
				},
				last ? ms + 150 : ((i + 1) * ms) / words.length,
			);
		});
	};

	// Which sentence each buffer speaks: request text -> Response -> ArrayBuffer -> AudioBuffer.
	const textOf = new WeakMap();
	const f = window.fetch;
	window.fetch = async (input, init) => {
		const res = await f(input, init);
		if (String(input).includes("/api/tts") && init?.method === "POST") {
			try {
				const text = JSON.parse(init.body).text;
				textOf.set(res, text);
				window.__rec("tts", { at: Date.now(), text });
			} catch {}
		}
		return res;
	};
	const arrayBuffer = Response.prototype.arrayBuffer;
	Response.prototype.arrayBuffer = async function () {
		const b = await arrayBuffer.call(this);
		if (textOf.has(this)) textOf.set(b, textOf.get(this));
		return b;
	};
	const decode = BaseAudioContext.prototype.decodeAudioData;
	BaseAudioContext.prototype.decodeAudioData = async function (b, ...rest) {
		const text = textOf.get(b);
		const out = await decode.call(this, b, ...rest);
		if (text) textOf.set(out, text);
		return out;
	};

	// Audio: copy every buffer the page plays, with its wall-clock start.
	let seq = 0;
	const start = AudioBufferSourceNode.prototype.start;
	AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
		const id = ++seq;
		this.__id = id;
		const buf = this.buffer;
		if (buf) {
			const at = Date.now() + Math.max(0, when - this.context.currentTime) * 1000;
			const ch = buf.getChannelData(0);
			const i16 = new Int16Array(ch.length);
			for (let i = 0; i < ch.length; i++) i16[i] = Math.max(-1, Math.min(1, ch[i])) * 32767;
			const bytes = new Uint8Array(i16.buffer);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			window.__rec("audio", { id, at, seconds: buf.duration, sr: buf.sampleRate, text: textOf.get(buf) ?? "", pcm: btoa(bin) });
		}
		return start.call(this, when, ...rest);
	};
	const stop = AudioBufferSourceNode.prototype.stop;
	AudioBufferSourceNode.prototype.stop = function (...a) {
		if (this.__id) window.__rec("stop", { id: this.__id, at: Date.now() });
		return stop.apply(this, a);
	};
});

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

const page = await context.newPage();
page.on("pageerror", (e) => log("pageerror", String(e)));
page.on("response", async (r) => {
	if (!r.url().endsWith("/api/chat")) return;
	const body = await r.json().catch(() => null);
	if (body) events.chat.push({ at: Date.now(), content: body.content, tools: (body.tool_calls ?? []).map((c) => c.function) });
});

// ── 3. screencast ────────────────────────────────────────────────────────────
const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
	const file = `frames/${String(frames.length).padStart(5, "0")}.jpg`;
	writeFileSync(join(outDir, file), Buffer.from(data, "base64"));
	frames.push({ file, t: metadata.timestamp * 1000 });
	await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});

await page.goto(`${BASE}/?lang=id`, { waitUntil: "networkidle" });
await page.addStyleTag({ content: `html { zoom: ${process.env.ZOOM ?? 1.2}; }` });
await page.click('[data-lang="id"]');
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await sleep(2000);

const state = () => page.locator(".stage").getAttribute("data-state");
async function waitState(want, timeoutMs = 60_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if ((await state()) === want) return;
		await sleep(100);
	}
	throw new Error(`timed out waiting for state ${want} (now ${await state()})`);
}
/** The agent has finished speaking and the mic has reopened. */
async function waitForTurnEnd() {
	await waitState("speaking");
	await waitState("listening", 120_000);
	await sleep(900);
}
async function say(i) {
	const line = SCRIPT[i];
	const ms = Math.round(line.seconds * 1000);
	events.user.push({ i, text: line.text, file: line.file, at: Date.now(), seconds: line.seconds });
	await page.evaluate(([t, d]) => window.__say(t, d), [line.text, ms]);
	log(`user: ${line.text}`);
	await sleep(ms + 300);
}

events.marks.orb = Date.now();
await page.click("#orb");
log("call started");
await waitForTurnEnd();
for (let i = 0; i < SCRIPT.length; i++) {
	const next = SCRIPT[i + 1];
	await say(i);
	if (next?.interruptAfterMs) {
		await waitState("speaking");
		await sleep(next.interruptAfterMs);
		events.marks.interrupt = Date.now();
		await page.click("#orb");
		log("interrupted");
		await sleep(700);
		continue;
	}
	await waitForTurnEnd();
}
await sleep(2500);
events.marks.end = Date.now();
await cdp.send("Page.stopScreencast");
writeFileSync(join(outDir, "frames.json"), JSON.stringify(frames));
writeFileSync(join(outDir, "events.json"), JSON.stringify({ ...events, script: SCRIPT }, null, 1));
log(`done: ${frames.length} frames, ${events.audio.length} agent buffers, ${((events.marks.end - events.marks.orb) / 1000).toFixed(1)} s`);
await browser.close();
