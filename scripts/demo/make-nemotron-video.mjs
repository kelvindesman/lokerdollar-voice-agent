#!/usr/bin/env node
/**
 * Demo video (Nemotron build), pass 2: assemble the MP4 from a recording made
 * by record-nemotron.mjs.
 *
 *   1. captions: `--skeleton` writes <recDir>/captions.json with every line the
 *      user said and every sentence group the agent spoke (in Bahasa). Fill in
 *      the `en` fields by hand, then run without `--skeleton`.
 *   2. live segment: screencast frames + the exact audio the page played + the
 *      user's lines, with silences longer than MAX_GAP shortened (disclosed on
 *      screen). Nothing inside a spoken line is cut.
 *   3. intro and outro slides narrated with Supertonic (English) via /api/tts.
 *
 * Usage: node scripts/demo/make-nemotron-video.mjs <appUrl> <recDir> <workDir> <out.mp4> [--skeleton]
 * Env: CHROME_PATH, PW_FROM, MAX_GAP (s, default 1.0)
 * Needs ffmpeg/ffprobe.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SKELETON = process.argv.includes("--skeleton");
const [BASE_RAW, recDirRaw, workDirRaw, outRaw] = args;
if (!BASE_RAW || !recDirRaw || (!SKELETON && (!workDirRaw || !outRaw))) {
	console.error("usage: make-nemotron-video.mjs <appUrl> <recDir> <workDir> <out.mp4> [--skeleton]");
	process.exit(2);
}
const BASE = BASE_RAW.replace(/\/$/, "");
const recDir = resolve(recDirRaw);
const ev = JSON.parse(readFileSync(join(recDir, "events.json"), "utf8"));
const framesIdx = JSON.parse(readFileSync(join(recDir, "frames.json"), "utf8"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── what was heard, when ─────────────────────────────────────────────────────
const stopAt = new Map(ev.stops.map((s) => [s.id, s.at]));
const audio = [...ev.audio].sort((a, b) => a.id - b.id);
/** Every agent buffer that was audible, with the sentence group it spoke. */
const agentClips = audio
	.map((a, k) => {
		const end = Math.min(a.at + a.seconds * 1000, stopAt.get(a.id) ?? Number.POSITIVE_INFINITY);
		return { kind: "agent", id: a.id, file: a.file, at: a.at, end, text: a.text || ev.tts[k]?.text || "" };
	})
	.filter((c) => c.end - c.at > 50);
const userClips = ev.user.map((u) => ({ kind: "user", id: `u${u.i}`, file: u.file, at: u.at, end: u.at + u.seconds * 1000, text: u.text }));
const clips = [...agentClips, ...userClips].sort((a, b) => a.at - b.at);

const capFile = join(recDir, "captions.json");
if (SKELETON) {
	const caps = clips.map((c) => ({ id: String(c.id), who: c.kind, id_text: c.text, en: "" }));
	writeFileSync(capFile, JSON.stringify(caps, null, 1));
	log(`wrote ${capFile} (${caps.length} lines); fill in "en", then rerun without --skeleton`);
	process.exit(0);
}
const captions = new Map(JSON.parse(readFileSync(capFile, "utf8")).map((c) => [c.id, c]));

const workDir = resolve(workDirRaw);
const outFile = resolve(outRaw);
mkdirSync(join(workDir, "cap"), { recursive: true });
const W = (f) => join(workDir, f);
const ff = (a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: ["ignore", "inherit", "inherit"] });
const probeDur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const VENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30"];
const AENC = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];

// ── 1. keep-intervals: speech plus short margins, long silences shortened ───
const MAX_GAP = Number(process.env.MAX_GAP ?? 1.0) * 1000;
const LEAD = 800;
const TAIL = 1200;
const start0 = ev.marks.orb - LEAD;
const end0 = Math.max(...clips.map((c) => c.end)) + TAIL;
// Speech intervals, plus the two taps worth seeing (call start, interrupt).
const moments = [
	...clips.map((c) => [c.at, c.end]),
	[ev.marks.orb - LEAD, ev.marks.orb + 500],
	...(ev.marks.interrupt ? [[ev.marks.interrupt - 400, ev.marks.interrupt + 300]] : []),
].sort((x, y) => x[0] - y[0]);
const speech = [];
for (const [a, b] of moments) {
	const last = speech[speech.length - 1];
	if (last && a <= last[1]) last[1] = Math.max(last[1], b);
	else speech.push([a, b]);
}
const keep = [];
let prevEnd = start0;
for (const [a, b] of speech) {
	if (a - prevEnd > MAX_GAP) keep.push([prevEnd, prevEnd + MAX_GAP / 2], [a - MAX_GAP / 2, b]);
	else keep.push([prevEnd, b]);
	prevEnd = Math.max(prevEnd, b);
}
keep.push([prevEnd, end0]);
const merged = [];
for (const k of keep) {
	const last = merged[merged.length - 1];
	if (last && k[0] <= last[1] + 1) last[1] = Math.max(last[1], k[1]);
	else merged.push([...k]);
}
const outTime = (t) => {
	let acc = 0;
	for (const [a, b] of merged) {
		if (t <= b) return acc + Math.max(0, t - a);
		acc += b - a;
	}
	return acc;
};
const liveMs = merged.reduce((s, [a, b]) => s + b - a, 0);
log(`live: ${((end0 - start0) / 1000).toFixed(1)} s recorded -> ${(liveMs / 1000).toFixed(1)} s after shortening ${merged.length - 1} pauses`);

// ── 2. live video from frames ────────────────────────────────────────────────
const frames = framesIdx.map((f) => ({ ...f, file: join(recDir, f.file) }));
const lines = [];
for (const [a, b] of merged) {
	let i = frames.findLastIndex((f) => f.t <= a);
	if (i < 0) i = 0;
	let t = a;
	while (t < b) {
		const next = frames[i + 1];
		const until = next ? Math.min(next.t, b) : b;
		const d = (until - t) / 1000;
		if (d > 0) lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(4)}`);
		t = until;
		if (!next || next.t >= b) break;
		i++;
	}
}
lines.push(lines[lines.length - 2]); // concat demuxer: repeat the last file
writeFileSync(W("frames.txt"), lines.join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", W("frames.txt"), "-vf", "pad=1920:1080:0:0:color=0x0c1a14,fps=30", ...VENC, "-an", W("live-v.mp4")]);
log("live video done");

// ── 3. live audio ────────────────────────────────────────────────────────────
const aIn = [];
const aF = [];
clips.forEach((c, k) => {
	aIn.push("-i", join(recDir, c.file));
	const dur = ((c.end - c.at) / 1000).toFixed(3);
	const delay = Math.round(outTime(c.at));
	aF.push(`[${k}:a]aresample=48000,aformat=channel_layouts=mono,atrim=0:${dur},afade=t=out:st=${Math.max(0, dur - 0.04).toFixed(3)}:d=0.04,adelay=${delay}:all=1[a${k}]`);
});
aF.push(`${clips.map((_, k) => `[a${k}]`).join("")}amix=inputs=${clips.length}:normalize=0,apad,atrim=0:${(liveMs / 1000).toFixed(3)}[mix]`);
ff([...aIn, "-filter_complex", aF.join(";"), "-map", "[mix]", ...AENC, W("live-a.m4a")]);
log("live audio done");

// ── 4. captions + slides (rendered with Playwright) ─────────────────────────
const require = createRequire(process.env.PW_FROM ?? `${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function renderCaption(file, who, text) {
	await page.setContent(`<!doctype html><html><head>${FONTS}<style>
		html,body{margin:0;background:transparent}
		.c{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);max-width:1640px;padding:12px 26px;border-radius:14px;
		   background:rgba(6,20,13,.86);color:#eef6ef;font:500 34px/1.3 Inter,sans-serif;text-align:center}
		.w{font-weight:600;color:${who === "user" ? "#f5c451" : "#3ddc84"}}
	</style></head><body><div class="c"><span class="w">${who === "user" ? "User" : "Loker"}:</span> ${esc(text)}</div></body></html>`);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 860, width: 1920, height: 220 } });
}
async function renderBanner(file, text) {
	await page.setContent(`<!doctype html><html><head>${FONTS}<style>
		html,body{margin:0;background:transparent}
		.b{position:absolute;right:28px;top:22px;max-width:760px;padding:12px 18px;border-radius:12px;background:rgba(6,20,13,.9);
		   border:1px solid #24473a;color:#b5cabd;font:400 22px/1.35 Inter,sans-serif}
		.b strong{color:#eef6ef;font-weight:600}
	</style></head><body><div class="b">${text}</div></body></html>`);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: file, omitBackground: true, clip: { x: 1100, y: 0, width: 820, height: 200 } });
}

const overlays = [];
for (const c of clips) {
	const cap = captions.get(String(c.id));
	if (!cap?.en) continue;
	const file = W(`cap/${c.id}.png`);
	await renderCaption(file, c.kind, cap.en);
	overlays.push({ file, x: 0, y: 860, from: outTime(c.at) / 1000, to: outTime(c.end) / 1000 + 0.25 });
}
await renderBanner(
	W("cap/banner.png"),
	"<strong>Live session, recorded 9 Oct 2026.</strong> Nemotron, the job tools, Tavily, and the Supertonic voice all ran live. The user's lines are synthesized speech fed in as speech-recognition results. Pauses over 1 s shortened.",
);
overlays.push({ file: W("cap/banner.png"), x: 1100, y: 0, from: 0, to: 9 });

const ov = overlays.flatMap((o) => ["-i", o.file]);
let chain = "[0:v]";
const vf = overlays.map((o, k) => {
	const outLabel = k === overlays.length - 1 ? "[v]" : `[o${k}]`;
	const s = `${chain}[${k + 1}:v]overlay=${o.x}:${o.y}:enable='between(t,${o.from.toFixed(2)},${o.to.toFixed(2)})'${outLabel}`;
	chain = outLabel;
	return s;
});
ff(["-i", W("live-v.mp4"), ...ov, "-i", W("live-a.m4a"), "-filter_complex", vf.join(";"), "-map", "[v]", "-map", `${overlays.length + 1}:a`, ...VENC, ...AENC, "-shortest", W("live.mp4")]);
log(`live segment done (${overlays.length} overlays)`);

// ── 5. narrated slides ───────────────────────────────────────────────────────
const SLIDE_CSS = `html,body{margin:0;width:1920px;height:1080px;background:#0c1a14;color:#eef6ef;font-family:Inter,sans-serif}
	.wrap{padding:110px 140px;box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center}
	h1{font:800 104px/1.02 "Bricolage Grotesque",sans-serif;margin:0 0 28px;letter-spacing:-.02em}
	h2{font:800 64px/1.05 "Bricolage Grotesque",sans-serif;margin:0 0 44px}
	p{font:400 36px/1.4 Inter,sans-serif;color:#b5cabd;margin:0 0 18px;max-width:1500px}
	em{font-style:normal;color:#3ddc84}
	.tag{display:inline-block;font:600 24px Inter;color:#062414;background:#3ddc84;border-radius:999px;padding:8px 20px;margin-bottom:34px}
	.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:26px}
	.box{background:#132b20;border:1px solid #24473a;border-radius:20px;padding:26px 28px}
	.box b{display:block;font:600 30px/1.2 Inter;color:#eef6ef;margin-bottom:10px}
	.box span{font:400 24px/1.4 Inter;color:#b5cabd}
	.hl{border-color:#3ddc84}`;
const SLIDES = [
	{
		name: "intro",
		html: `<div class="wrap"><span class="tag">Nebius × NVIDIA Global AI Hackathon</span>
			<h1>LokerDollar Voice</h1>
			<p>Talk, in <em>Bahasa Indonesia</em>, to find remote jobs that pay in <em>US dollars</em>.</p>
			<p>Brain: <em>NVIDIA Nemotron</em> on <em>Nebius Token Factory</em>. Live job data. Tavily company checks. Supertonic voice.</p></div>`,
		say: [
			"Remote jobs paid in dollars can earn Indonesians several times the local wage.",
			"LokerDollar Voice finds them when you just ask, in Bahasa Indonesia. Here is a live session.",
		],
	},
	{
		name: "arch",
		html: `<div class="wrap"><h2>How it works</h2><div class="grid">
			<div class="box"><b>Browser</b><span>Speech recognition (id-ID), numbered job cards that light up as the agent talks, tap to interrupt.</span></div>
			<div class="box hl"><b>NVIDIA Nemotron · Nebius Token Factory</b><span>Nemotron 3.5 Lightning plans each turn, calls tools, and answers in casual Indonesian. A model call takes about half a second.</span></div>
			<div class="box"><b>Cloudflare Worker</b><span>Holds every API key, rate-limits the public demo, proxies chat, tools, and voice.</span></div>
			<div class="box"><b>search_jobs · get_job</b><span>Live LokerDollar remote-job database: salary floor, "surely open to Indonesia" filter, pay in rupiah.</span></div>
			<div class="box"><b>company_check · Tavily</b><span>"Is this company legit?" One web search, a short spoken summary, sources on screen.</span></div>
			<div class="box"><b>Supertonic voice</b><span>Open-weights ONNX speech in a Cloudflare Container, about 4x faster than real time, sentence by sentence.</span></div>
		</div></div>`,
		say: [
			"NVIDIA Nemotron on Nebius Token Factory is the brain.",
			"It answers in casual Indonesian and calls three tools: live job search, job details with pay in rupiah, and a Tavily lookup that checks whether an employer is real.",
			"Supertonic speaks each reply from a Cloudflare Container.",
		],
	},
	{
		name: "end",
		html: `<div class="wrap" style="align-items:flex-start"><h1 style="font-size:88px">Try it: <em>lokerdollar-voice-agent<br>.kelvin-6d2.workers.dev</em></h1>
			<p>Code: github.com/kelvindesman/lokerdollar-voice-agent · Jobs: lokerdollar.com</p></div>`,
		say: [],
		seconds: 3,
	},
];

async function narrate(sentences, file) {
	const parts = [];
	for (const [k, text] of sentences.entries()) {
		const res = await fetch(`${BASE}/api/tts`, {
			method: "POST",
			headers: { "content-type": "application/json", referer: `${BASE}/` },
			body: JSON.stringify({ text, lang: "en", voice: "M1" }),
		});
		if (!res.ok) throw new Error(`narration TTS HTTP ${res.status}`);
		const f = `${file}.${k}.wav`;
		writeFileSync(f, Buffer.from(await res.arrayBuffer()));
		parts.push(f);
	}
	// 0.35 s between sentences, 0.6 s lead-in.
	const inputs = parts.flatMap((p) => ["-i", p]);
	const pads = parts.map((_, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=0.35[p${k}]`);
	ff([...inputs, "-filter_complex", `${pads.join(";")};${parts.map((_, k) => `[p${k}]`).join("")}concat=n=${parts.length}:v=0:a=1,adelay=600:all=1[a]`, "-map", "[a]", file]);
}

for (const s of SLIDES) {
	await page.setContent(`<!doctype html><html><head>${FONTS}<style>${SLIDE_CSS}</style></head><body>${s.html}</body></html>`);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: W(`${s.name}.png`) });
	const out = W(`${s.name}.mp4`);
	if (s.say.length) {
		const wav = W(`${s.name}.wav`);
		if (!existsSync(wav)) await narrate(s.say, wav);
		const d = probeDur(wav) + 0.8;
		ff(["-loop", "1", "-i", W(`${s.name}.png`), "-i", wav, "-filter_complex", "[1:a]apad[a]", "-map", "0:v", "-map", "[a]", "-t", d.toFixed(2), ...VENC, ...AENC, out]);
	} else {
		ff(["-loop", "1", "-i", W(`${s.name}.png`), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(s.seconds), ...VENC, ...AENC, out]);
	}
	log(`slide ${s.name} done`);
}
await browser.close();

// ── 6. join: intro, live, arch, end ──────────────────────────────────────────
const order = [W("intro.mp4"), W("live.mp4"), W("arch.mp4"), W("end.mp4")];
const inputs = order.flatMap((f) => ["-i", f]);
const cat = `${order.map((_, k) => `[${k}:v][${k}:a]`).join("")}concat=n=${order.length}:v=1:a=1[v][a0];[a0]loudnorm=I=-16:TP=-1.5:LRA=11[a]`;
ff([...inputs, "-filter_complex", cat, "-map", "[v]", "-map", "[a]", ...VENC, ...AENC, "-movflags", "+faststart", outFile]);
log(`done: ${outFile} (${probeDur(outFile).toFixed(1)} s)`);
