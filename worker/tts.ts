/**
 * Supertonic-3 speech (Supertone, OpenRAIL-M; 31 languages including
 * Indonesian), run in a Cloudflare Container.
 *
 * The container reuses LokerDollar's social-video image, which already ships
 * Node 24, onnxruntime-node, and the Supertonic engine port, with the image
 * pinned by its unique tag in wrangler.jsonc. Only the entrypoint differs: a
 * ~60-line HTTP server (SERVER below) that loads the weights once and turns one
 * sentence into a WAV.
 *
 *   GET  /      {"ready":bool,"error":string|null}  (also the warm-up ping)
 *   POST /      {"text","lang","voice","speed","steps"} -> audio/wav
 */

import { Container } from "@cloudflare/containers";

const SERVER = String.raw`
import http from "node:http";
const { ensureWeights } = await import("/app/src/supertonic/weights.ts");
const { loadSupertonic, encodeWav } = await import("/app/src/supertonic/engine.ts");
const { normalizeIdText } = await import("/app/src/supertonic/normalize-id.ts");

const dir = process.env.SUPERTONIC_DIR || "/opt/supertonic";
let engine = null;
let loadError = null;
const t0 = Date.now();
const ready = ensureWeights(dir, process.env.SUPERTONIC_R2_URL || "")
	.then(() => loadSupertonic(dir))
	.then((e) => {
		engine = e;
		console.log("supertonic ready in " + (Date.now() - t0) + " ms");
	})
	.catch((err) => {
		loadError = String(err && err.message ? err.message : err);
		console.error("supertonic load failed: " + loadError);
	});

// One synthesis at a time: parallel ONNX runs on 2 vCPU only slow each other down.
let queue = Promise.resolve();
const serial = (fn) => {
	const run = queue.then(fn, fn);
	queue = run.catch(() => {});
	return run;
};

const VOICES = new Set(["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]);

http
	.createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ready: engine !== null, error: loadError }));
			return;
		}
		let body = "";
		req.on("data", (c) => {
			body += c;
			if (body.length > 4000) req.destroy();
		});
		req.on("end", async () => {
			try {
				const p = JSON.parse(body || "{}");
				const lang = p.lang === "en" ? "en" : "id";
				const text = String(p.text || "").slice(0, 300).trim();
				const voice = VOICES.has(p.voice) ? p.voice : "F1";
				const speed = Math.min(1.4, Math.max(0.8, Number(p.speed) || 1.05));
				const steps = Math.min(10, Math.max(3, Number(p.steps) || 6));
				if (!text) throw new Error("empty text");
				await ready;
				if (!engine) throw new Error("engine not loaded: " + loadError);
				const started = Date.now();
				const wav = await serial(async () => {
					const style = await engine.loadVoiceStyle(voice);
					const spoken = normalizeIdText(text, lang) || text;
					const pcm = await engine.synthesize(spoken, lang, style, steps, speed);
					return encodeWav(pcm, engine.sampleRate);
				});
				res.writeHead(200, {
					"content-type": "audio/wav",
					"x-synth-ms": String(Date.now() - started),
				});
				res.end(wav);
			} catch (err) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
			}
		});
	})
	.listen(8080, () => console.log("tts server listening on 8080"));
`;

export class SupertonicTTS extends Container {
	defaultPort = 8080;
	// Weights take a while to load; keep a warm instance through a demo session.
	sleepAfter = "20m";
	// Needs egress for the one-time weight download from R2 (assets.lokerdollar.com).
	enableInternet = true;
	entrypoint = [
		"node",
		"--experimental-strip-types",
		"--input-type=module",
		"-e",
		SERVER,
	];
}
