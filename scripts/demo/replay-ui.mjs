#!/usr/bin/env node
/**
 * Demo video, pass 2: render the deployed web app driven by the session that
 * record-session.mjs captured, and screen-capture it (CDP screencast, JPEG +
 * timestamps).
 *
 * The page runs its normal code. Only the network edges are replaced:
 *   - the AssemblyAI socket → a fake socket that re-delivers every recorded
 *     server event (transcripts, word timings, reply audio, tool calls) at its
 *     recorded time
 *   - /api/token → a dummy token (no real session is opened)
 *   - /api/tools/search_jobs → the Worker's recorded responses, after the
 *     recorded latency
 *   - the microphone → the recorded user clips at their recorded times
 *
 * Why: a live screen capture on a loaded 8 GB laptop starved the page and
 * delayed the mic audio by up to ~37 s. Recording the session headless-free in
 * Node and re-rendering the UI from its event log keeps both the conversation
 * and the picture faithful.
 *
 * Usage: node scripts/demo/replay-ui.mjs <appUrl> <sessionDir> <clipsDir> <outDir> <endSeconds> [langSwitchSeconds]
 * Env: CHROME_PATH, PW_FROM, VIEWPORT (1920x1080), ZOOM (1.3), NTH (2)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, sessionDir, clipsDir, outDir, endSecRaw, langSecRaw] = process.argv.slice(2);
if (!url || !sessionDir || !clipsDir || !outDir || !endSecRaw) {
	console.error("usage: replay-ui.mjs <appUrl> <sessionDir> <clipsDir> <outDir> <endSeconds> [langSwitchSeconds]");
	process.exit(2);
}
const END_MS = Number(endSecRaw) * 1000;
const LANG_MS = langSecRaw ? Number(langSecRaw) * 1000 : null;
const require = createRequire(process.env.PW_FROM ?? `${process.cwd()}/package.json`);
let chromium;
try {
	({ chromium } = require("playwright"));
} catch {
	({ chromium } = require("@playwright/test"));
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const session = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8"));
const script = session.events
	.filter((e) => e.t <= END_MS + 2000)
	.map((e) => (e.ev.type === "reply.audio" ? { t: e.t, ev: { type: "reply.audio", data: session.agentChunks[e.ev.n].b64 } } : e));
const clips = session.clips.map((c) => ({ ...c, b64: readFileSync(join(clipsDir, `${c.name}.wav`)).toString("base64") }));
const toolCalls = session.events.filter((e) => e.ev.type === "tool.call" && e.ev.name === "search_jobs");
const searchReplies = session.toolResponses
	.filter((r) => r.name === "search_jobs")
	.map((r, i) => ({ body: r.body, latencyMs: Math.max(0, r.t - (toolCalls[i]?.t ?? r.t)) }));

const framesDir = join(outDir, "frames");
mkdirSync(framesDir, { recursive: true });

const INIT = () => {
	const epoch = () => performance.timeOrigin + performance.now();
	const OrigWS = window.WebSocket;
	class ReplaySocket {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		constructor() {
			this.readyState = 0;
			this.onopen = this.onmessage = this.onclose = this.onerror = null;
			setTimeout(() => {
				this.readyState = 1;
				const t0 = epoch();
				window.__replayT0 = t0;
				this.onopen?.({});
				for (const { t, ev } of window.__script) {
					const fire = () => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify(ev) });
					const wait = t0 + t - epoch();
					if (wait <= 0) fire();
					else setTimeout(fire, wait);
				}
				window.__startMic?.(t0);
			}, 150);
		}
		send() {}
		close() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.onclose?.({ code: 1000 });
		}
		addEventListener() {}
	}
	window.WebSocket = function (u, p) {
		return String(u).startsWith("wss://agents.assemblyai.com") ? new ReplaySocket() : new OrigWS(u, p);
	};
	Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

	navigator.mediaDevices.getUserMedia = async () => {
		const ctx = new AudioContext({ sampleRate: 48000 });
		await ctx.resume();
		const dest = ctx.createMediaStreamDestination();
		const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
		const d = noise.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.0015;
		const n = ctx.createBufferSource();
		n.buffer = noise;
		n.loop = true;
		n.connect(dest);
		n.start();
		window.__startMic = async (t0) => {
			for (const c of window.__clips) {
				const bin = atob(c.b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const audio = await ctx.decodeAudioData(bytes.buffer);
				const wait = t0 + c.t - epoch();
				setTimeout(() => {
					const s = ctx.createBufferSource();
					s.buffer = audio;
					s.connect(dest);
					s.start();
				}, Math.max(0, wait));
			}
		};
		return dest.stream;
	};
};

const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
	args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--disable-features=AudioServiceOutOfProcess"],
});
const [VW, VH] = (process.env.VIEWPORT ?? "1920x1080").split("x").map(Number);
const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on("console", (m) => m.type() === "error" && log("console error:", m.text()));
await page.addInitScript(INIT);
await page.route("**/api/token", (r) => r.fulfill({ json: { token: "replay", maxSessionSeconds: 600 } }));
let searchNo = 0;
await page.route("**/api/tools/search_jobs", async (r) => {
	const reply = searchReplies[searchNo++] ?? { body: { query: null, widened: false, total: 0, jobs: [] }, latencyMs: 0 };
	await new Promise((res) => setTimeout(res, reply.latencyMs));
	await r.fulfill({ json: reply.body });
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.addStyleTag({ content: `html { zoom: ${process.env.ZOOM ?? 1.3}; }` });
await page.evaluate(([s, c]) => ((window.__script = s), (window.__clips = c)), [script, clips]);
await page.waitForTimeout(1500);

const cdp = await context.newCDPSession(page);
const frames = [];
let frameNo = 0;
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
	const file = `f${String(frameNo++).padStart(6, "0")}.jpg`;
	writeFileSync(join(framesDir, file), Buffer.from(data, "base64"));
	frames.push({ file, ts: metadata.timestamp });
	try {
		await cdp.send("Page.screencastFrameAck", { sessionId });
	} catch {}
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: VW, maxHeight: VH, everyNthFrame: Number(process.env.NTH ?? 2) });
await page.waitForTimeout(2500);

await page.click("#orb");
await page.waitForFunction(() => window.__replayT0, null, { timeout: 15000 });
const t0 = await page.evaluate(() => window.__replayT0);
log("replay started");
const elapsed = async () => (await page.evaluate(() => performance.timeOrigin + performance.now())) - t0;
let langDone = LANG_MS === null;
while ((await elapsed()) < END_MS) {
	if (!langDone && (await elapsed()) >= LANG_MS) {
		await page.click('[data-lang="id"]');
		langDone = true;
		log("switched to ID");
	}
	await page.waitForTimeout(200);
}
await cdp.send("Page.stopScreencast").catch(() => {});
await browser.close();
writeFileSync(join(outDir, "replay.json"), JSON.stringify({ t0, frames, viewport: [VW, VH] }));
log(`frames=${frames.length}`);
