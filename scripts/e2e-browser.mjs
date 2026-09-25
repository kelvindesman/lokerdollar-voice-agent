#!/usr/bin/env node
/**
 * Real-browser e2e: headless Chrome with a FAKE MICROPHONE fed from a WAV file,
 * driving the deployed app exactly as a user would (click the orb, speak).
 *
 * Usage:
 *   node scripts/e2e-browser.mjs <url> <mic.wav> <outDir> [durationMs]
 * Needs Playwright (`pnpm dlx playwright install chromium` or an existing install).
 * Optional: CHROME_PATH to use a specific Chrome binary.
 *
 * The WAV should contain spoken prompts separated by quiet "room tone" (not
 * digital zeros). Chrome loops the file as the microphone.
 */
import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/package.json`);
let chromium;
try {
	({ chromium } = require("playwright"));
} catch {
	({ chromium } = require("@playwright/test"));
}

const url = process.argv[2];
const wav = process.argv[3];
const outDir = process.argv[4];
const waitMs = Number(process.argv[5] ?? 40000);

const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
	args: [
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		`--use-file-for-fake-audio-capture=${wav}`,
		"--autoplay-policy=no-user-gesture-required",
		"--disable-features=AudioServiceOutOfProcess",
	],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
globalThis.sent = {};
page.on("websocket", (ws) => {
	ws.on("framesent", (f) => { try { const t = JSON.parse(String(f.payload)).type; globalThis.sent[t] = (globalThis.sent[t] ?? 0) + 1; } catch {} });
	ws.on("framereceived", (f) => {
		try {
			const ev = JSON.parse(String(f.payload));
			if (ev.type === "reply.audio" || ev.type === "transcript.agent.delta" || ev.type === "transcript.user.delta") return;
			logs.push(`<< ${ev.type} ${JSON.stringify(ev).slice(0, 220)}`);
		} catch {}
	});
});
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(1500);
await page.click("#orb");
const t0 = Date.now();
const shots = { cards: 0, active: 0, expanded: 0 };
let lastLine = "";
while (Date.now() - t0 < waitMs) {
	await page.waitForTimeout(1500);
	const n = await page.locator(".card").count();
	const active = await page.locator(".card.active").count();
	const expanded = await page.locator(".card.expanded").count();
	const state = await page.locator(".stage").getAttribute("data-state");
	const line = `sent=${JSON.stringify(globalThis.sent)} state=${state} cards=${n} active=${active} expanded=${expanded}`;
	if (line !== lastLine) console.log(`${Math.round((Date.now() - t0) / 1000)}s ${line}`);
	lastLine = line;
	if (n > 0 && !shots.cards) { shots.cards = 1; await page.waitForTimeout(2500); await page.screenshot({ path: `${outDir}/incall-results.png` }); }
	if (active > 0 && shots.active < 1) { shots.active++; await page.screenshot({ path: `${outDir}/incall-highlight.png` }); }
	if (expanded > 0 && !shots.expanded) { shots.expanded = 1; await page.waitForTimeout(3000); await page.screenshot({ path: `${outDir}/incall-details.png` }); }
}
await page.screenshot({ path: `${outDir}/incall-final.png` });
const transcript = await page.locator("#transcript").innerText();
console.log("TRANSCRIPT:\n" + transcript);
await page.click("#orb").catch(() => {});
await page.waitForTimeout(2000);
console.log(logs.filter((l) => !l.includes("session.updated")).slice(0, 80).join("\n"));
await browser.close();
