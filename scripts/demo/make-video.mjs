#!/usr/bin/env node
/**
 * Demo video, pass 3: assemble submission/demo.mp4 (1920x1080, H.264 + AAC).
 *
 * Inputs: the session from record-session.mjs, the frames from replay-ui.mjs,
 * submission/cover.png, submission/slides.pdf. Narration is synthesized with
 * macOS `say`. Needs ffmpeg + pdftoppm (poppler) and Playwright (captions).
 *
 * Usage: node scripts/demo/make-video.mjs <sessionDir> <replayDir> <workDir> <out.mp4>
 * Env: PW_FROM, CHROME_PATH, LIVE_START (s, default -1.5), LIVE_END (s, default 83.5),
 *      FADE_AT (s, default 80.0: agent audio fades out from here)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [sessionDir, replayDir, workDir, outFile] = process.argv.slice(2).map((p) => p && resolve(p));
if (!sessionDir || !replayDir || !workDir || !outFile) {
	console.error("usage: make-video.mjs <sessionDir> <replayDir> <workDir> <out.mp4>");
	process.exit(2);
}
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_START = Number(process.env.LIVE_START ?? -1.5);
const LIVE_END = Number(process.env.LIVE_END ?? 83.5);
const FADE_AT = Number(process.env.FADE_AT ?? 80.0);
mkdirSync(workDir, { recursive: true });
const W = (f) => join(workDir, f);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const probeDur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

const VENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-video_track_timescale", "30000"];
const AENC = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];
const LOUD = "loudnorm=I=-16:TP=-1.5:LRA=11";

// ── 1. narration ─────────────────────────────────────────────────────────────
const NARRATION = {
	n1: "Remote jobs that pay in US dollars can earn an Indonesian worker about seven times the local minimum wage. Finding them is the hard part. This is LokerDollar Voice, a real-time voice agent that finds those jobs for you.",
	n2: "Most remote job boards are built for American applicants. Pay is quoted in dollars per year. And searching means typing English filters. Talking is easier.",
	n3: "Here is a real session with AssemblyAI's Voice Agent API and live LokerDollar job data. The user's voice is synthesized for this recording.",
	n4: "Under the hood, one AssemblyAI Voice Agent connection handles speech recognition, the language model, the voice, turn-taking, and interruptions. A Cloudflare Worker mints single-use tokens, so the API key never reaches the browser. Job search runs as client-side tool calls to LokerDollar's job server. That's why the cards appear before the agent starts talking, and each card lights up as the agent reads it.",
	n5: "LokerDollar has about four thousand eight hundred open remote jobs, drawn from more than twenty-nine thousand postings indexed since launch. One honest limit: AssemblyAI doesn't recognize Indonesian speech yet. So Indonesian mode gives you an Indonesian interface, while the agent replies in simple English.",
	n6: "Next up: a phone line through AssemblyAI SIP, and interview practice. Try it now, at the link on screen.",
};
for (const [k, text] of Object.entries(NARRATION)) {
	if (existsSync(W(`${k}.wav`))) continue;
	execFileSync("say", ["-v", process.env.NARRATOR ?? "Samantha", "-r", "178", "-o", W(`${k}.aiff`), text]);
	ff(["-i", W(`${k}.aiff`), "-ar", "48000", "-ac", "1", W(`${k}.wav`)]);
}
log("narration ready");

// ── 2. slides → PNG ──────────────────────────────────────────────────────────
if (!existsSync(W("slide-1.png"))) {
	execFileSync("pdftoppm", ["-png", "-scale-to-x", "1920", "-scale-to-y", "1080", join(REPO, "submission/slides.pdf"), W("slide")]);
}
const slide = (n) => {
	for (const f of [`slide-${n}.png`, `slide-0${n}.png`]) if (existsSync(W(f))) return W(f);
	throw new Error(`slide ${n} missing`);
};

// ── 3. caption + badge overlays (transparent PNGs, rendered with Chromium) ────
const session = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8"));
const replay = JSON.parse(readFileSync(join(replayDir, "replay.json"), "utf8"));
const clips = session.clips.map((c) => ({ ...c, start: c.t / 1000, end: c.t / 1000 + c.duration }));
{
	const require = createRequire(process.env.PW_FROM ?? `${process.cwd()}/package.json`);
	let chromium;
	try {
		({ chromium } = require("playwright"));
	} catch {
		({ chromium } = require("@playwright/test"));
	}
	const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
	const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
	const css = `html,body{margin:0;background:transparent;font-family:Inter,-apple-system,"Helvetica Neue",Arial,sans-serif}
	.cap{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);max-width:1500px;padding:18px 30px;border-radius:18px;
	background:rgba(6,20,14,.86);color:#fff;font-size:38px;line-height:1.3;font-weight:600;box-shadow:0 10px 40px rgba(0,0,0,.45);text-align:center}
	.cap b{color:#3ddc84;font-weight:700;margin-right:10px}
	.badge{position:absolute;left:50%;top:18px;transform:translateX(-50%);padding:9px 18px;border-radius:999px;background:rgba(6,20,14,.82);
	color:#d9f7e5;font-size:22px;font-weight:600;border:1px solid rgba(61,220,132,.45);white-space:nowrap}
	.badge i{display:inline-block;width:12px;height:12px;border-radius:50%;background:#ff5a4f;margin-right:10px;vertical-align:1px}`;
	const shot = async (html, file) => {
		await page.setContent(`<style>${css}</style>${html}`);
		await page.screenshot({ path: W(file), omitBackground: true });
	};
	for (const c of clips) await shot(`<div class="cap"><b>User:</b>“${c.text}”</div>`, `cap-${c.name}.png`);
	await shot(
		`<div class="badge"><i></i>Real AssemblyAI Voice Agent session · live LokerDollar jobs · user voice synthesized</div>`,
		"badge.png",
	);
	await browser.close();
}
log("overlays ready");

// ── 4. live segment: frames → video, session audio, overlays, dead-air cuts ──
const t0 = replay.t0 / 1000;
const frames = replay.frames.map((f) => ({ ...f, t: f.ts - t0 })).filter((f) => f.t >= LIVE_START - 1 && f.t <= LIVE_END + 0.5);
let list = "";
let first = frames.findIndex((f) => f.t >= LIVE_START);
if (first > 0) first -= 1; // include the frame on screen at LIVE_START
for (let i = first; i < frames.length; i++) {
	const from = Math.max(frames[i].t, LIVE_START);
	const to = i + 1 < frames.length ? frames[i + 1].t : LIVE_END;
	if (to <= from) continue;
	list += `file '${join(replayDir, "frames", frames[i].file)}'\nduration ${(Math.min(to, LIVE_END) - from).toFixed(4)}\n`;
	if (to >= LIVE_END) break;
}
list += `file '${join(replayDir, "frames", frames[frames.length - 1].file)}'\n`;
writeFileSync(W("frames.txt"), list);
const liveLen = LIVE_END - LIVE_START;

// Speech activity from the session tracks (25 ms windows) → keep intervals.
function activity(file) {
	const buf = readFileSync(file);
	const d = buf.indexOf(Buffer.from("data"));
	const rate = buf.readUInt32LE(buf.indexOf(Buffer.from("fmt ")) + 12);
	const pcm = buf.subarray(d + 8);
	const win = Math.round(rate * 0.025);
	const out = [];
	for (let i = 0; i + win * 2 <= pcm.length; i += win * 2) {
		let sum = 0;
		for (let j = 0; j < win; j++) {
			const v = pcm.readInt16LE(i + j * 2);
			sum += v * v;
		}
		out.push(20 * Math.log10(Math.sqrt(sum / win) / 32768 + 1e-9) > -45);
	}
	return out; // index * 0.025 s, session time
}
const agentAct = activity(join(sessionDir, "agent.wav"));
const userAct = activity(join(sessionDir, "user.wav"));
const busy = (t) => {
	const i = Math.floor(t / 0.025);
	return (agentAct[i] ?? false) || (userAct[i] ?? false);
};
const visualMoments = session.toolResponses.map((r) => r.t / 1000); // cards appear
const cuts = [];
{
	// Quiet runs (both tracks silent) longer than 2.5 s keep 0.8 s after speech and
	// 1.2 s before the next speech; inside, only a short window where cards appear.
	const runs = [];
	let quietFrom = null;
	const lo = Math.max(1, LIVE_START);
	const hi = FADE_AT - 0.5;
	for (let t = lo; t <= hi; t += 0.025) {
		const quiet = !busy(t);
		if (quiet && quietFrom === null) quietFrom = t;
		if ((!quiet || t + 0.025 > hi) && quietFrom !== null) {
			if (t - quietFrom > 2.5) runs.push([quietFrom, t]);
			quietFrom = null;
		}
	}
	for (const [qa, qb] of runs) {
		let a = qa + 0.8;
		const b = qb - 1.2;
		for (const m of visualMoments.filter((m) => m > a && m < b).sort((x, y) => x - y)) {
			if (m - 0.4 - a > 0.4) cuts.push([a, m - 0.4]);
			a = m + 1.2;
		}
		if (b - a > 0.4) cuts.push([a, b]);
	}
}
const keeps = [];
{
	let at = LIVE_START;
	for (const [a, b] of cuts) {
		keeps.push([at, a]);
		at = b;
	}
	keeps.push([at, LIVE_END]);
}
log("dead-air cuts (session s):", cuts.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(" "));

// Build the uncut live video with audio + overlays, then apply the cuts.
const lead = Math.round(-LIVE_START * 1000);
const capFilters = clips
	.map((c, i) => `[v${i}][${3 + i}:v]overlay=0:0:enable='between(t,${(c.start - LIVE_START).toFixed(2)},${(c.end - LIVE_START + 1.2).toFixed(2)})'[v${i + 1}]`)
	.join(";");
const n = clips.length;
const fadeStart = (FADE_AT - LIVE_START).toFixed(2);
ff([
	"-f", "concat", "-safe", "0", "-i", W("frames.txt"),
	"-i", join(sessionDir, "agent.wav"),
	"-i", join(sessionDir, "user.wav"),
	...clips.flatMap((c) => ["-loop", "1", "-i", W(`cap-${c.name}.png`)]),
	"-loop", "1", "-i", W("badge.png"),
	"-filter_complex",
	[
		`[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v0]`,
		capFilters,
		`[v${n}][${3 + n}:v]overlay=0:0[vout]`,
		`[1:a]aresample=48000,adelay=${lead}|${lead},afade=t=out:st=${fadeStart}:d=1.2[ag]`,
		`[2:a]aresample=48000,adelay=${lead}|${lead},volume=0.9[us]`,
		`[ag][us]amix=inputs=2:normalize=0:duration=longest,apad[aout]`,
	].join(";"),
	"-map", "[vout]", "-map", "[aout]", "-t", liveLen.toFixed(2),
	...VENC, ...AENC, W("live-uncut.mp4"),
]);
const sel = keeps.map(([a, b]) => `between(t,${(a - LIVE_START).toFixed(3)},${(b - LIVE_START).toFixed(3)})`).join("+");
ff([
	"-i", W("live-uncut.mp4"),
	"-vf", `select='${sel}',setpts=N/FRAME_RATE/TB`,
	"-af", `aselect='${sel}',asetpts=N/SR/TB,${LOUD}`,
	...VENC, ...AENC, W("seg-4-live.mp4"),
]);
log(`live: ${liveLen.toFixed(1)}s → ${probeDur(W("seg-4-live.mp4")).toFixed(1)}s after cuts`);

// ── 5. still segments with narration ─────────────────────────────────────────
function still(image, narration, out, { pre = 0.6, post = 0.9 } = {}) {
	const dur = probeDur(narration) + pre + post;
	ff([
		"-loop", "1", "-framerate", "30", "-i", image, "-i", narration,
		"-filter_complex",
		`[0:v]scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.35).toFixed(2)}:d=0.35[v];` +
			`[1:a]aresample=48000,adelay=${Math.round(pre * 1000)}|${Math.round(pre * 1000)},apad,${LOUD}[a]`,
		"-map", "[v]", "-map", "[a]", "-t", dur.toFixed(2), ...VENC, ...AENC, out,
	]);
	return out;
}
// Idle app frame (before the call starts) for the live intro.
const idle = frames.find((f) => f.t >= LIVE_START) ?? frames[0];
ff(["-i", join(replayDir, "frames", idle.file), "-vf", "scale=1920:1080:flags=lanczos", "-frames:v", "1", W("idle.png")]);
const segs = [
	still(join(REPO, "submission/cover.png"), W("n1.wav"), W("seg-1.mp4")),
	still(slide(2), W("n2.wav"), W("seg-2.mp4")),
	still(W("idle.png"), W("n3.wav"), W("seg-3.mp4"), { pre: 0.4, post: 0.4 }),
	W("seg-4-live.mp4"),
	still(slide(4), W("n4.wav"), W("seg-5.mp4")),
	still(slide(6), W("n5.wav"), W("seg-6.mp4")),
	still(slide(7), W("n6.wav"), W("seg-7.mp4"), { pre: 0.6, post: 2.5 }),
];
writeFileSync(W("segments.txt"), segs.map((s) => `file '${s}'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", W("segments.txt"), "-c", "copy", "-movflags", "+faststart", outFile]);
log(`wrote ${outFile}: ${probeDur(outFile).toFixed(1)}s`);
for (const s of segs) log(`  ${s.split("/").pop()}: ${probeDur(s).toFixed(1)}s`);
