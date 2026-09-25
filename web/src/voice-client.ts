/**
 * Browser client for the AssemblyAI Voice Agent API.
 *
 * - Mints a single-use token from our Worker, opens wss://agents.assemblyai.com/v1/ws
 * - Streams mic audio (PCM16 mono 24 kHz, resampled in an AudioWorklet)
 * - Plays reply.audio, flushing on barge-in (reply.done status=interrupted)
 * - Runs client-side tools (search_jobs / get_job) against our Worker and
 *   returns tool.result exactly when reply.done is the latest event
 */

import { type Lang, sessionUpdate } from "./agent-config";

const WS_URL = "wss://agents.assemblyai.com/v1/ws";
const RATE = 24_000;

export type AgentState =
	| "idle"
	| "connecting"
	| "listening"
	| "thinking"
	| "speaking"
	| "error";

export type ToolRunner = (
	name: string,
	args: Record<string, unknown>,
) => Promise<unknown>;

export type VoiceEvents = {
	state: (s: AgentState) => void;
	userPartial: (itemId: string, text: string) => void;
	userFinal: (itemId: string, text: string) => void;
	agentWord: (replyId: string, word: string) => void;
	agentFinal: (replyId: string, text: string, interrupted: boolean) => void;
	toolStart: (name: string, args: Record<string, unknown>) => void;
	level: (v: number) => void;
	error: (message: string) => void;
	ended: () => void;
};

type ServerEvent = { type: string; [k: string]: unknown };

function toBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(s);
}

function fromBase64Pcm(b64: string): Float32Array {
	const raw = atob(b64);
	const n = raw.length >> 1;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		let v = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
		if (v >= 0x8000) v -= 0x10000;
		out[i] = v / 32768;
	}
	return out;
}

export class VoiceClient {
	private ws: WebSocket | null = null;
	private ctx: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private worklet: AudioWorkletNode | null = null;
	private isReady = false;
	private muted = false;
	private playhead = 0;
	private sources = new Set<AudioBufferSourceNode>();
	private lastEvent: string | null = null;
	private pending: { call_id: string; result: string; is_error: boolean }[] =
		[];
	private state: AgentState = "idle";
	private speakingTimer: number | null = null;

	constructor(
		private readonly on: Partial<VoiceEvents>,
		private readonly runTool: ToolRunner,
	) {}

	get active(): boolean {
		return this.ws !== null;
	}

	get ready(): boolean {
		return this.isReady;
	}

	/** Mutable fields only (system_prompt, tools, keyterms, turn_detection …). */
	updateSession(session: Record<string, unknown>): void {
		if (!this.isReady || this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify({ type: "session.update", session }));
	}

	private setState(s: AgentState) {
		if (this.state === s) return;
		this.state = s;
		this.on.state?.(s);
	}

	async start(lang: Lang): Promise<void> {
		if (this.ws) return;
		this.setState("connecting");
		try {
			// Audio must start inside the user gesture; do it before any await on network.
			const ctx = new AudioContext();
			this.ctx = ctx;
			const streamP = navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: false,
					autoGainControl: true,
					channelCount: 1,
				},
			});
			await ctx.resume();
			const [stream] = await Promise.all([
				streamP,
				ctx.audioWorklet.addModule("/pcm-capture.js"),
			]);
			this.stream = stream;

			const res = await fetch("/api/token", {
				headers: { accept: "application/json" },
			});
			const body = (await res.json().catch(() => ({}))) as {
				token?: string;
				message?: string;
			};
			if (!res.ok || !body.token) {
				throw new Error(
					body.message ??
						`Could not start a voice session (HTTP ${res.status}).`,
				);
			}

			const source = ctx.createMediaStreamSource(stream);
			const worklet = new AudioWorkletNode(ctx, "pcm-capture", {
				processorOptions: {
					inputSampleRate: ctx.sampleRate,
					targetSampleRate: RATE,
				},
			});
			this.worklet = worklet;
			worklet.port.onmessage = (
				e: MessageEvent<{ pcm: ArrayBuffer; level: number }>,
			) => {
				this.on.level?.(this.muted ? 0 : e.data.level);
				if (!this.isReady || this.muted || this.ws?.readyState !== WebSocket.OPEN)
					return;
				this.ws.send(
					JSON.stringify({ type: "input.audio", audio: toBase64(e.data.pcm) }),
				);
			};
			// Keep the worklet pulled by the graph without playing the mic back.
			const sink = ctx.createGain();
			sink.gain.value = 0;
			source.connect(worklet).connect(sink).connect(ctx.destination);

			const url = new URL(WS_URL);
			url.searchParams.set("token", body.token);
			const ws = new WebSocket(url);
			this.ws = ws;
			ws.onopen = () => ws.send(JSON.stringify(sessionUpdate(lang)));
			ws.onmessage = (ev) => {
				try {
					this.handle(JSON.parse(String(ev.data)) as ServerEvent);
				} catch (err) {
					console.warn("bad event", err);
				}
			};
			ws.onclose = (ev) => {
				if (this.ws === ws) {
					if (!this.isReady && ev.code !== 1000) {
						this.on.error?.(
							"The voice service closed the connection. Please try again.",
						);
					}
					this.cleanup();
				}
			};
			ws.onerror = () => {
				/* onclose follows with details */
			};
		} catch (err) {
			const msg =
				err instanceof DOMException && err.name === "NotAllowedError"
					? "Microphone permission was denied. Allow the mic and try again."
					: err instanceof Error
						? err.message
						: String(err);
			this.on.error?.(msg);
			this.cleanup();
			this.setState("error");
		}
	}

	/** Clean end: session.end stops billing immediately; server replies session.ended. */
	stop(): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "session.end" }));
			window.setTimeout(() => this.cleanup(), 1500);
		} else {
			this.cleanup();
		}
	}

	/** Synchronous end for pagehide. */
	endNow(): void {
		if (this.ws?.readyState === WebSocket.OPEN)
			this.ws.send(JSON.stringify({ type: "session.end" }));
	}

	setMuted(m: boolean): void {
		this.muted = m;
	}

	/** Typed input or a card tap: inject a user message and ask for a reply. */
	sendText(text: string): void {
		if (!this.isReady || this.ws?.readyState !== WebSocket.OPEN) return;
		this.flushPlayback();
		this.ws.send(
			JSON.stringify({
				type: "conversation.message",
				role: "user",
				content: text,
			}),
		);
		this.ws.send(JSON.stringify({ type: "reply.create" }));
		this.setState("thinking");
	}

	private handle(ev: ServerEvent): void {
		switch (ev.type) {
			case "session.ready":
				this.isReady = true;
				this.setState("listening");
				break;
			case "input.speech.started":
				this.lastEvent = ev.type;
				this.setState("listening");
				break;
			case "input.speech.stopped":
				this.setState("thinking");
				break;
			case "transcript.user.delta":
				this.on.userPartial?.(String(ev.item_id ?? ""), String(ev.text ?? ""));
				break;
			case "transcript.user":
				this.on.userFinal?.(String(ev.item_id ?? ""), String(ev.text ?? ""));
				break;
			case "reply.started":
				this.lastEvent = ev.type;
				break;
			case "reply.audio":
				this.play(String(ev.data ?? ""));
				break;
			case "transcript.agent.delta":
				this.on.agentWord?.(String(ev.reply_id ?? ""), String(ev.delta ?? ""));
				break;
			case "transcript.agent":
				this.on.agentFinal?.(
					String(ev.reply_id ?? ""),
					String(ev.text ?? ""),
					ev.interrupted === true,
				);
				break;
			case "reply.done":
				this.lastEvent = ev.type;
				if (ev.status === "interrupted") {
					this.flushPlayback();
					this.pending = [];
					this.setState("listening");
				} else {
					this.flushTools();
				}
				break;
			case "tool.call":
				void this.onToolCall(ev);
				break;
			case "session.error": {
				const code = String(ev.code ?? "");
				const msg = String(ev.message ?? "Voice session error");
				console.warn("session.error", code, msg);
				// Client-message errors keep the session alive; only surface fatal ones loudly.
				if (
					!this.isReady ||
					[
						"session_expired",
						"at_capacity",
						"concurrency_exceeded",
						"UNAUTHORIZED",
						"FORBIDDEN",
					].includes(code)
				) {
					this.on.error?.(
						code === "session_expired" ? "Session time limit reached." : msg,
					);
				}
				break;
			}
			case "session.ended":
				this.cleanup();
				break;
			default:
				break;
		}
	}

	private async onToolCall(ev: ServerEvent): Promise<void> {
		const callId = String(ev.call_id ?? "");
		const name = String(ev.name ?? "");
		const args = (
			ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {}
		) as Record<string, unknown>;
		this.setState("thinking");
		this.on.toolStart?.(name, args);
		let result: string;
		let isError = false;
		try {
			result = JSON.stringify(await this.runTool(name, args));
		} catch (err) {
			isError = true;
			result = JSON.stringify({
				error: `${err instanceof Error ? err.message : String(err)} Tell the user the job search is briefly unavailable and offer to try again.`,
			});
		}
		this.pending.push({ call_id: callId, result, is_error: isError });
		this.flushTools();
	}

	/** Send tool results only when reply.done is the latest event (per Voice Agent docs). */
	private flushTools(): void {
		if (this.lastEvent !== "reply.done" || this.pending.length === 0) return;
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		for (const p of this.pending) {
			this.ws.send(JSON.stringify({ type: "tool.result", ...p }));
		}
		this.pending = [];
	}

	private play(b64: string): void {
		const ctx = this.ctx;
		if (!ctx || !b64) return;
		const samples = fromBase64Pcm(b64);
		if (samples.length === 0) return;
		const buffer = ctx.createBuffer(1, samples.length, RATE);
		buffer.getChannelData(0).set(samples);
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		src.connect(ctx.destination);
		const now = ctx.currentTime;
		this.playhead = Math.max(this.playhead, now + 0.03);
		src.start(this.playhead);
		this.playhead += buffer.duration;
		this.sources.add(src);
		src.onended = () => this.sources.delete(src);
		this.setState("speaking");
		if (this.speakingTimer) window.clearTimeout(this.speakingTimer);
		this.speakingTimer = window.setTimeout(
			() => {
				if (this.state === "speaking") this.setState("listening");
			},
			(this.playhead - now) * 1000 + 150,
		);
	}

	private flushPlayback(): void {
		for (const s of this.sources) {
			try {
				s.stop();
			} catch {
				/* already stopped */
			}
		}
		this.sources.clear();
		this.playhead = this.ctx?.currentTime ?? 0;
	}

	private cleanup(): void {
		const hadWs = this.ws !== null;
		this.isReady = false;
		this.flushPlayback();
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
		this.worklet?.port.close();
		this.worklet = null;
		for (const t of this.stream?.getTracks() ?? []) t.stop();
		this.stream = null;
		void this.ctx?.close().catch(() => {});
		this.ctx = null;
		this.pending = [];
		this.lastEvent = null;
		if (this.state !== "error") this.setState("idle");
		if (hadWs) this.on.ended?.();
	}
}
