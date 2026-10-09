/**
 * Voice loop with NVIDIA Nemotron (Nebius Token Factory) as the brain.
 *
 *   mic  -> browser speech recognition (id-ID or en-US, interim results)
 *        -> POST /api/chat (Worker adds prompt, tools, key; calls Nemotron)
 *        -> tool calls run here in the browser (cards render immediately)
 *        -> reply spoken by the browser's speech engine in the user's language
 *
 * Same event surface as the AssemblyAI VoiceClient, so the UI is shared.
 *
 * Half duplex: the mic is closed while the agent speaks. Browser speech
 * recognition has no echo cancellation against our own speech output, so on
 * laptop speakers it transcribes the agent and answers itself (seen in the
 * headless e2e). Interrupting is a tap or typed message: interrupt() cancels
 * playback and drops any in-flight model or tool result for the old turn.
 */

import { chatGreeting, type Lang } from "../../shared/nemotron";
import type { AgentState, ToolRunner, VoiceEvents } from "./voice-client";

type ToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

type Msg =
	| { role: "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
	| { role: "tool"; content: string; tool_call_id: string };

type ChatReply = {
	content: string | null;
	tool_calls: ToolCall[];
	model?: string;
	ms?: number;
	message?: string;
};

// Minimal Web Speech API typings (not in lib.dom for every TS version).
type RecResult = { isFinal: boolean; 0: { transcript: string } };
type RecEvent = { resultIndex: number; results: ArrayLike<RecResult> };
type Recognition = {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((e: RecEvent) => void) | null;
	onerror: ((e: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
};

function recognitionCtor(): (new () => Recognition) | null {
	const w = window as unknown as {
		SpeechRecognition?: new () => Recognition;
		webkitSpeechRecognition?: new () => Recognition;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceInputSupported(): boolean {
	return recognitionCtor() !== null;
}

/** Max model calls per user turn (search, maybe get_job, then the answer). */
const MAX_HOPS = 4;
const FILLER: Record<Lang, string> = {
	en: "One sec, checking.",
	id: "Sebentar, aku cek dulu.",
};

/** Words the speech engine can't say well: markdown, URLs, ids. */
export function speakable(text: string): string {
	return text
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\bjob_[a-z0-9_]+\b/gi, "")
		.replace(/[*_#`>|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Sentence chunks: Chrome cuts off single utterances longer than ~15 s. */
export function chunks(text: string): string[] {
	// Split only where punctuation is followed by a space, so "3.8" stays whole.
	const parts = text.split(/(?<=[.!?])\s+/);
	const out: string[] = [];
	for (const p of parts) {
		const s = p.trim();
		if (!s) continue;
		const last = out[out.length - 1];
		if (last && last.length + s.length < 120)
			out[out.length - 1] = `${last} ${s}`;
		else out.push(s);
	}
	return out;
}

function words(s: string): string[] {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
}

/** True when what the mic heard is mostly the agent's own voice. */
export function looksLikeEcho(
	heard: string,
	spoken: string,
	threshold = 0.5,
): boolean {
	const h = words(heard);
	if (h.length === 0) return true;
	const s = new Set(words(spoken));
	const overlap = h.filter((w) => s.has(w)).length / h.length;
	return overlap >= threshold;
}

/**
 * Recognition finalizes a phrase up to ~2 s after the audio, so an echo of the
 * agent's last sentence can arrive after playback ended. Inside this window a
 * near-verbatim match is still treated as echo.
 */
const ECHO_TAIL_MS = 2500;

export class NemotronVoiceClient {
	private lang: Lang = "en";
	private running = false;
	private muted = false;
	private state: AgentState = "idle";
	private history: Msg[] = [];
	/** Bumped on every new user turn; stale model/tool results compare against it. */
	private turn = 0;
	private rec: Recognition | null = null;
	private stream: MediaStream | null = null;
	private ctx: AudioContext | null = null;
	/** Supertonic (neural, server-side) voice; null until the container reports ready. */
	private neural = false;
	private playCtx: AudioContext | null = null;
	private playhead = 0;
	private sources = new Set<AudioBufferSourceNode>();
	private ttsAbort: AbortController | null = null;
	private raf = 0;
	private itemSeq = 0;
	private itemId = "";
	private speaking: { replyId: string; text: string } | null = null;
	/** Everything spoken recently, for echo rejection (endedAt = Infinity while playing). */
	private recent: { text: string; endedAt: number }[] = [];
	/** Mic closed while the agent speaks (half duplex). */
	private deaf = false;
	private reopenTimer = 0;
	private wordTimers = new Set<number>();

	constructor(
		private readonly on: Partial<VoiceEvents>,
		private readonly runTool: ToolRunner,
	) {}

	get active(): boolean {
		return this.running;
	}

	get ready(): boolean {
		return this.running;
	}

	setLang(lang: Lang): void {
		if (lang === this.lang) return;
		this.lang = lang;
		if (this.rec) {
			// Recognition language is fixed per session; restart in the new one.
			this.rec.abort();
		}
	}

	setMuted(m: boolean): void {
		this.muted = m;
	}

	private setState(s: AgentState) {
		if (this.state === s) return;
		this.state = s;
		this.on.state?.(s);
	}

	async start(lang: Lang): Promise<void> {
		if (this.running) return;
		this.lang = lang;
		this.running = true;
		this.history = [];
		this.setState("connecting");
		// Created inside the click that started the call, so playback is allowed.
		this.playCtx ??= new AudioContext();
		void this.playCtx.resume();
		// A warm container answers in well under a second: give it that long so
		// the greeting is already in the neural voice, then carry on regardless.
		const warm = this.warmNeural();
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true },
			});
			this.meter(this.stream);
		} catch {
			this.on.error?.(
				lang === "id"
					? "Mikrofon tidak diizinkan. Kamu tetap bisa mengetik."
					: "Microphone blocked. You can still type.",
			);
		}
		await Promise.race([warm, new Promise((ok) => setTimeout(ok, 1500))]);
		if (!this.running) return;
		this.listen();
		const greet = chatGreeting(lang);
		this.history.push({ role: "assistant", content: greet });
		this.setState("listening");
		this.speak(greet, this.turn);
	}

	stop(): void {
		this.endNow();
	}

	endNow(): void {
		if (!this.running) return;
		this.running = false;
		this.turn++;
		window.clearTimeout(this.reopenTimer);
		this.deaf = false;
		this.cancelSpeech(false);
		this.rec?.abort();
		this.rec = null;
		for (const t of this.stream?.getTracks() ?? []) t.stop();
		this.stream = null;
		cancelAnimationFrame(this.raf);
		void this.ctx?.close();
		this.ctx = null;
		this.setState("idle");
		this.on.ended?.();
	}

	/** Typed input or a card tap: same path as a spoken turn. */
	sendText(text: string): void {
		if (!this.running) return;
		void this.userTurn(text);
	}

	get isSpeaking(): boolean {
		return this.speaking !== null;
	}

	/** Tap-to-interrupt: stop talking, drop the in-flight turn, listen again. */
	interrupt(): void {
		if (!this.running) return;
		this.cancelSpeech(true);
		this.turn++;
		this.setState("listening");
	}

	private closeMic() {
		window.clearTimeout(this.reopenTimer);
		if (this.deaf) return;
		this.deaf = true;
		this.rec?.abort();
	}

	/** Reopen shortly after playback so the speaker's tail is not transcribed. */
	private openMic() {
		window.clearTimeout(this.reopenTimer);
		this.reopenTimer = window.setTimeout(() => {
			if (!this.running || this.speaking) return;
			this.deaf = false;
			try {
				this.rec?.start();
			} catch {
				/* already started */
			}
		}, 350);
	}

	/** Kept for interface parity with the AssemblyAI client. */
	updateSession(_session: Record<string, unknown>): void {}

	// ── input ────────────────────────────────────────────────────────────────

	private listen() {
		const Ctor = recognitionCtor();
		if (!Ctor) {
			this.on.error?.(
				this.lang === "id"
					? "Browser ini belum bisa input suara. Coba Chrome, atau ketik saja."
					: "This browser has no voice input. Try Chrome, or type instead.",
			);
			return;
		}
		const rec = new Ctor();
		rec.lang = this.lang === "id" ? "id-ID" : "en-US";
		rec.continuous = true;
		rec.interimResults = true;
		this.itemId = `n${++this.itemSeq}`;

		rec.onresult = (e) => {
			if (this.muted) return;
			let interim = "";
			let final = "";
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const r = e.results[i];
				if (!r) continue;
				if (r.isFinal) final += r[0].transcript;
				else interim += r[0].transcript;
			}
			const heard = (final || interim).trim();
			if (!heard) return;
			const now = performance.now();
			this.recent = this.recent.filter((r) => r.endedAt > now - ECHO_TAIL_MS);
			const echoRef = this.recent.map((r) => r.text).join(" ");
			// A late-finalized echo of what the agent just said is not the user.
			if (this.deaf || (echoRef && looksLikeEcho(heard, echoRef, 0.8))) return;
			if (final) {
				this.on.userFinal?.(this.itemId, final.trim());
				const text = final.trim();
				this.itemId = `n${++this.itemSeq}`;
				void this.userTurn(text);
			} else {
				this.on.userPartial?.(this.itemId, interim.trim());
			}
		};
		rec.onerror = (e) => {
			if (e.error === "not-allowed" || e.error === "service-not-allowed") {
				this.on.error?.(
					this.lang === "id"
						? "Izin mikrofon ditolak. Kamu tetap bisa mengetik."
						: "Microphone permission denied. You can still type.",
				);
				this.rec = null;
			}
			// no-speech / aborted / network: onend restarts while the call is live.
		};
		rec.onend = () => {
			if (this.running && this.rec === rec && !this.deaf) {
				try {
					rec.lang = this.lang === "id" ? "id-ID" : "en-US";
					rec.start();
				} catch {
					/* already started */
				}
			}
		};
		this.rec = rec;
		try {
			rec.start();
		} catch {
			/* already started */
		}
	}

	private meter(stream: MediaStream) {
		const ctx = new AudioContext();
		this.ctx = ctx;
		const an = ctx.createAnalyser();
		an.fftSize = 512;
		ctx.createMediaStreamSource(stream).connect(an);
		const buf = new Float32Array(an.fftSize);
		const tick = () => {
			an.getFloatTimeDomainData(buf);
			let sum = 0;
			for (const v of buf) sum += v * v;
			let lvl = Math.sqrt(sum / buf.length);
			if (this.speaking)
				lvl = Math.max(lvl, 0.12 + 0.08 * Math.sin(performance.now() / 120));
			this.on.level?.(this.muted ? 0 : lvl);
			this.raf = requestAnimationFrame(tick);
		};
		tick();
	}

	// ── the turn ─────────────────────────────────────────────────────────────

	private async userTurn(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean || !this.running) return;
		this.cancelSpeech(true);
		const turn = ++this.turn;
		this.history.push({ role: "user", content: clean });
		this.setState("thinking");

		try {
			for (let hop = 0; hop < MAX_HOPS; hop++) {
				const reply = await this.ask();
				if (turn !== this.turn) return;
				const calls = reply.tool_calls ?? [];
				if (calls.length === 0) {
					const say = speakable(reply.content ?? "");
					this.history.push({ role: "assistant", content: say });
					if (say) this.speak(say, turn);
					else this.setState("listening");
					return;
				}
				this.history.push({
					role: "assistant",
					content: reply.content ?? null,
					tool_calls: calls,
				});
				if (hop === 0)
					this.speak(
						speakable(reply.content ?? "") || FILLER[this.lang],
						turn,
						true,
					);
				for (const call of calls) {
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(call.function.arguments || "{}") as Record<
							string,
							unknown
						>;
					} catch {
						/* model sent bad JSON; run with no args */
					}
					this.on.toolStart?.(call.function.name, args);
					let result: unknown;
					try {
						result = await this.runTool(call.function.name, args);
					} catch (err) {
						result = {
							error: err instanceof Error ? err.message : String(err),
						};
					}
					if (turn !== this.turn) return;
					this.history.push({
						role: "tool",
						tool_call_id: call.id,
						content: JSON.stringify(result),
					});
				}
			}
			this.setState("listening");
		} catch (err) {
			if (turn !== this.turn) return;
			// Keep history valid for the next turn: drop this unanswered turn.
			while (
				this.history.length &&
				this.history[this.history.length - 1]?.role !== "user"
			)
				this.history.pop();
			this.history.pop();
			this.on.error?.(err instanceof Error ? err.message : String(err));
			this.setState("listening");
		}
	}

	private async ask(): Promise<ChatReply> {
		const res = await fetch("/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lang: this.lang, messages: this.history }),
		});
		const data = (await res.json().catch(() => ({}))) as ChatReply;
		if (!res.ok) {
			throw new Error(
				data.message ??
					(this.lang === "id"
						? `Loker sedang sibuk (HTTP ${res.status}). Coba lagi.`
						: `Loker is busy (HTTP ${res.status}). Try again.`),
			);
		}
		return data;
	}

	// ── output ───────────────────────────────────────────────────────────────

	private pickVoice(): SpeechSynthesisVoice | null {
		const want = this.lang === "id" ? "id" : "en";
		const voices = speechSynthesis
			.getVoices()
			.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(want));
		const prefer =
			want === "id"
				? [/google bahasa indonesia/i, /damayanti/i, /gadis|ardi/i]
				: [/google us english/i, /samantha/i, /aria|jenny/i];
		for (const re of prefer) {
			const v = voices.find((x) => re.test(x.name));
			if (v) return v;
		}
		return voices[0] ?? null;
	}

	/**
	 * Wake the Supertonic container. A cold start (weights from R2 plus ONNX
	 * load) takes about 90 s, so the browser voice covers the first replies
	 * and the neural voice takes over as soon as it is ready.
	 */
	private async warmNeural() {
		for (let i = 0; i < 40 && this.running && !this.neural; i++) {
			try {
				const r = (await (await fetch("/api/tts")).json()) as {
					ready?: boolean;
				};
				if (r.ready) {
					this.neural = true;
					return;
				}
			} catch {
				/* keep polling */
			}
			await new Promise((ok) => setTimeout(ok, 5000));
		}
	}

	private speak(text: string, turn: number, filler = false) {
		if (!text || turn !== this.turn || !this.running) return;
		const replyId = `r${turn}${filler ? "f" : ""}`;
		this.speaking = { replyId, text };
		this.closeMic();
		const entry = { text, endedAt: Number.POSITIVE_INFINITY };
		this.recent.push(entry);
		if (!filler) this.setState("speaking");
		const done = () => {
			entry.endedAt = performance.now();
			if (this.speaking?.replyId !== replyId) return;
			this.speaking = null;
			this.openMic();
			this.on.agentFinal?.(replyId, text, false);
			if (!filler && turn === this.turn) this.setState("listening");
		};
		if (this.neural && this.playCtx)
			void this.speakNeural(text, turn, replyId, done);
		else this.speakBrowser(text, turn, replyId, done);
	}

	/**
	 * Supertonic: one request per sentence group, fetched in order while the
	 * previous one plays (synthesis is ~4x faster than real time), scheduled
	 * back to back on one AudioContext. Words are paced across each buffer's
	 * duration so the matching job card lights up as it is spoken.
	 */
	private async speakNeural(
		text: string,
		turn: number,
		replyId: string,
		done: () => void,
	) {
		const ctx = this.playCtx;
		if (!ctx) return;
		const abort = new AbortController();
		this.ttsAbort = abort;
		const parts = chunks(text);
		const fetchPart = async (part: string) => {
			const res = await fetch("/api/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: part, lang: this.lang, voice: "F1", speed: 1.1 }),
				signal: abort.signal,
			});
			if (!res.ok) throw new Error(`tts HTTP ${res.status}`);
			return ctx.decodeAudioData(await res.arrayBuffer());
		};
		let next = fetchPart(parts[0] ?? text);
		for (let i = 0; i < parts.length; i++) {
			let buf: AudioBuffer;
			try {
				buf = await next;
			} catch {
				if (turn !== this.turn || abort.signal.aborted) return;
				// Container gone or slow: finish this reply with the browser voice.
				this.neural = false;
				void this.warmNeural();
				this.speakBrowser(parts.slice(i).join(" "), turn, replyId, done);
				return;
			}
			if (turn !== this.turn || abort.signal.aborted) return;
			const nextPart = parts[i + 1];
			if (nextPart) next = fetchPart(nextPart);
			const src = ctx.createBufferSource();
			src.buffer = buf;
			src.connect(ctx.destination);
			const at = Math.max(ctx.currentTime + 0.02, this.playhead);
			src.start(at);
			this.playhead = at + buf.duration;
			this.sources.add(src);
			const part = parts[i] ?? "";
			const ws = part.split(/\s+/).filter(Boolean);
			const startDelay = (at - ctx.currentTime) * 1000;
			ws.forEach((w, k) => {
				const t = window.setTimeout(
					() => {
						this.wordTimers.delete(t);
						if (turn === this.turn) this.on.agentWord?.(replyId, w);
					},
					startDelay + (k / ws.length) * buf.duration * 1000,
				);
				this.wordTimers.add(t);
			});
			const last = i === parts.length - 1;
			src.onended = () => {
				this.sources.delete(src);
				if (last && turn === this.turn) done();
			};
		}
	}

	private speakBrowser(
		text: string,
		turn: number,
		replyId: string,
		done: () => void,
	) {
		const parts = chunks(text);
		const voice = this.pickVoice();
		parts.forEach((part, i) => {
			const u = new SpeechSynthesisUtterance(part);
			u.lang = this.lang === "id" ? "id-ID" : "en-US";
			if (voice) u.voice = voice;
			u.rate = 1.05;
			let boundaries = false;
			u.onboundary = (e) => {
				if (e.name !== "word" || turn !== this.turn) return;
				boundaries = true;
				const w = part.slice(e.charIndex).match(/^\S+/)?.[0];
				if (w) this.on.agentWord?.(replyId, w);
			};
			u.onstart = () => {
				// Network voices often fire no word boundaries; pace words by estimate.
				const id = window.setTimeout(() => {
					if (boundaries || turn !== this.turn) return;
					const ws = part.split(/\s+/).filter(Boolean);
					const perWord = Math.max(180, (part.length / 14 / ws.length) * 1000);
					ws.forEach((w, k) => {
						const t = window.setTimeout(() => {
							this.wordTimers.delete(t);
							if (turn === this.turn) this.on.agentWord?.(replyId, w);
						}, k * perWord);
						this.wordTimers.add(t);
					});
				}, 250);
				this.wordTimers.add(id);
			};
			u.onend = () => {
				if (i === parts.length - 1) done();
			};
			speechSynthesis.speak(u);
		});
	}

	private cancelSpeech(interrupted: boolean) {
		for (const t of this.wordTimers) clearTimeout(t);
		this.wordTimers.clear();
		const cur = this.speaking;
		this.speaking = null;
		const now = performance.now();
		for (const r of this.recent) if (r.endedAt > now) r.endedAt = now;
		speechSynthesis.cancel();
		this.ttsAbort?.abort();
		this.ttsAbort = null;
		for (const src of this.sources) {
			src.onended = null;
			try {
				src.stop();
			} catch {
				/* not started */
			}
		}
		this.sources.clear();
		this.playhead = 0;
		if (this.running) this.openMic();
		if (cur && interrupted) this.on.agentFinal?.(cur.replyId, cur.text, true);
	}
}
