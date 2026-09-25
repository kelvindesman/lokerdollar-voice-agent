import { formatIdrMonthly, type VoiceJob } from "../../shared/jobs";
import { type Lang, systemPrompt } from "./agent-config";
import { STRINGS, type Strings } from "./i18n";
import "./styles.css";
import { type AgentState, VoiceClient } from "./voice-client";

// ── state ────────────────────────────────────────────────────────────────────

const LANG_KEY = "ldv-lang";
let lang: Lang = readLang();
let t: Strings = STRINGS[lang];
let jobs: VoiceJob[] = [];
let lastQuery: string | null = null;
let state: AgentState = "idle";
let queuedText: string | null = null;
let muted = false;

function readLang(): Lang {
	try {
		const v = localStorage.getItem(LANG_KEY);
		if (v === "en" || v === "id") return v;
	} catch {
		/* storage unavailable */
	}
	return navigator.language?.toLowerCase().startsWith("id") ? "id" : "en";
}

// ── dom ──────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(sel: string) =>
	document.querySelector(sel) as T;
const stage = $<HTMLDivElement>(".stage");
const orb = $<HTMLButtonElement>("#orb");
const orbLabel = $<HTMLSpanElement>("#orb-label");
const statusEl = $<HTMLParagraphElement>("#status");
const muteBtn = $<HTMLButtonElement>("#mute");
const transcript = $<HTMLDivElement>("#transcript");
const exampleList = $<HTMLUListElement>("#example-list");
const examples = $<HTMLDivElement>("#examples");
const typebox = $<HTMLFormElement>("#typebox");
const typed = $<HTMLInputElement>("#typed");
const cards = $<HTMLOListElement>("#cards");
const empty = $<HTMLParagraphElement>("#empty");
const meta = $<HTMLParagraphElement>("#results-meta");
const rateNote = $<HTMLParagraphElement>("#rate-note");

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	if (text != null) node.textContent = text;
	return node;
}

// ── i18n ─────────────────────────────────────────────────────────────────────

function applyLang() {
	t = STRINGS[lang];
	document.documentElement.lang = lang;
	for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
		const key = node.dataset.i18n as keyof Strings;
		const v = t[key];
		if (typeof v === "string") node.textContent = v;
	}
	typed.placeholder = t.typePlaceholder;
	for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
		b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
	}
	exampleList.replaceChildren(
		...t.examples.map((ex) => {
			const li = el("li");
			const btn = el("button", { type: "button", class: "chip" }, ex);
			btn.addEventListener("click", () => submitText(ex));
			li.append(btn);
			return li;
		}),
	);
	renderState();
	renderCards();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
	b.addEventListener("click", () => {
		const next = b.dataset.lang === "id" ? "id" : "en";
		if (next === lang) return;
		lang = next;
		try {
			localStorage.setItem(LANG_KEY, lang);
		} catch {
			/* ignore */
		}
		applyLang();
		// system_prompt is mutable mid-session; voice and greeting are not.
		client.updateSession({ system_prompt: systemPrompt(lang) });
	});
}

// ── state rendering ──────────────────────────────────────────────────────────

function renderState() {
	stage.dataset.state = state;
	const active = state !== "idle" && state !== "error";
	orb.setAttribute("aria-pressed", String(active));
	orb.setAttribute("aria-label", active ? t.stop : t.start);
	orbLabel.textContent = active ? t.stop : t.start;
	statusEl.textContent =
		state === "idle"
			? t.idle
			: state === "connecting"
				? t.connecting
				: state === "listening"
					? t.listening
					: state === "thinking"
						? t.thinking
						: state === "speaking"
							? t.speaking
							: statusEl.textContent || t.error;
	muteBtn.hidden = !active || state === "connecting";
	muteBtn.textContent = muted ? t.unmute : t.mute;
	muteBtn.setAttribute("aria-pressed", String(muted));
}

// ── transcript ───────────────────────────────────────────────────────────────

const bubbles = new Map<string, HTMLParagraphElement>();

function bubble(key: string, who: "user" | "agent"): HTMLParagraphElement {
	let b = bubbles.get(key);
	if (!b) {
		b = el("p", { class: `line ${who}` });
		b.append(
			el("span", { class: "who" }, who === "user" ? t.you : t.agent),
			el("span", { class: "text" }),
		);
		bubbles.set(key, b);
		transcript.append(b);
		while (transcript.childElementCount > 30) {
			const first = transcript.firstElementChild;
			if (!first) break;
			first.remove();
		}
		examples.hidden = true;
	}
	return b;
}

function setBubbleText(b: HTMLParagraphElement, text: string, partial = false) {
	const span = b.querySelector(".text");
	if (span) span.textContent = text;
	b.classList.toggle("partial", partial);
	transcript.scrollTop = transcript.scrollHeight;
}

// ── cards ────────────────────────────────────────────────────────────────────

let activeRank: number | null = null;
let expandedRank: number | null = null;

function renderCards() {
	cards.replaceChildren();
	empty.hidden = jobs.length > 0;
	rateNote.hidden = !jobs.some((j) => j.payIdrMonthly);
	for (const job of jobs) {
		const li = el("li", { class: "card", "data-rank": String(job.rank) });
		if (job.rank === activeRank) li.classList.add("active");
		if (job.rank === expandedRank) li.classList.add("expanded");

		const rank = el(
			"span",
			{ class: "rank", "aria-hidden": "true" },
			String(job.rank),
		);
		const body = el("div", { class: "card-body" });
		const title = el("h3", { class: "card-title" });
		const link = el(
			"a",
			{ href: job.url, target: "_blank", rel: "noopener" },
			job.title,
		);
		title.append(el("span", { class: "sr-only" }, `${job.rank}. `), link);
		const company = el("p", { class: "company" }, job.company ?? "");
		const pay = el("p", { class: "pay" });
		pay.append(el("strong", {}, job.payLabel ?? t.salaryNA));
		if (job.payIdrMonthly)
			pay.append(
				el("span", { class: "idr" }, formatIdrMonthly(job.payIdrMonthly, lang)),
			);
		const badges = el("p", { class: "badges" });
		badges.append(
			el(
				"span",
				{ class: `badge ${job.eligibility}` },
				t.eligibility[job.eligibility],
			),
		);
		if (job.applicantRegion)
			badges.append(el("span", { class: "badge region" }, t.regionOnly(job.applicantRegion)));

		const actions = el("div", { class: "actions" });
		const apply = el(
			"a",
			{
				class: "btn small",
				href: job.applyUrl,
				target: "_blank",
				rel: "noopener",
			},
			t.apply,
		);
		const view = el(
			"a",
			{
				class: "btn small ghost",
				href: job.url,
				target: "_blank",
				rel: "noopener",
			},
			t.openJob,
		);
		const ask = el(
			"button",
			{ type: "button", class: "btn small ghost" },
			t.askAbout,
		);
		ask.addEventListener("click", () =>
			submitText(t.askAboutPrompt(job.rank, job.title, job.company)),
		);
		actions.append(apply, view, ask);

		body.append(title, company, pay, badges, actions);
		li.append(rank, body);
		cards.append(li);
	}
}

function highlight(rank: number | null) {
	if (rank === activeRank) return;
	activeRank = rank;
	for (const c of cards.querySelectorAll<HTMLLIElement>(".card")) {
		c.classList.toggle("active", Number(c.dataset.rank) === rank);
	}
	if (rank != null) {
		cards
			.querySelector<HTMLLIElement>(`.card[data-rank="${rank}"]`)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}
}

// Follow the agent's speech: light up the card it is talking about.
const ORDINALS: Record<string, number> = {
	one: 1,
	first: 1,
	"1": 1,
	satu: 1,
	two: 2,
	second: 2,
	"2": 2,
	dua: 2,
	three: 3,
	third: 3,
	"3": 3,
	tiga: 3,
	four: 4,
	fourth: 4,
	"4": 4,
	empat: 4,
	five: 5,
	fifth: 5,
	"5": 5,
	lima: 5,
	six: 6,
	sixth: 6,
	"6": 6,
	enam: 6,
};
let speechWindow: string[] = [];

function followSpeech(word: string) {
	const w = word.toLowerCase().replace(/[^a-z0-9.]/g, "");
	if (!w) return;
	speechWindow.push(w);
	if (speechWindow.length > 6) speechWindow.shift();
	const prev = speechWindow[speechWindow.length - 2];
	const n = ORDINALS[w];
	if (
		n &&
		n <= jobs.length &&
		(prev === "number" ||
			prev === "nomor" ||
			prev === "the" ||
			w.endsWith("st") ||
			w.endsWith("nd") ||
			w.endsWith("rd") ||
			w.endsWith("th"))
	) {
		highlight(n);
		return;
	}
	const joined = speechWindow.join(" ");
	for (const j of jobs) {
		const c = j.company?.toLowerCase().replace(/[^a-z0-9. ]/g, "");
		if (
			c &&
			c.length > 2 &&
			joined.endsWith(c.split(" ").slice(-1)[0] ?? "") &&
			joined.includes(c.split(" ")[0] ?? "")
		) {
			highlight(j.rank);
			return;
		}
	}
}

// ── tools (run in the browser, backed by the Worker) ─────────────────────────

async function postTool<T>(name: string, body: unknown): Promise<T> {
	const res = await fetch(`/api/tools/${name}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as T & { message?: string };
	if (!res.ok && res.status !== 404)
		throw new Error(data.message ?? `Job search failed (HTTP ${res.status}).`);
	return data;
}

type SearchResponse = {
	query: string | null;
	widened: boolean;
	total: number;
	jobs: VoiceJob[];
	note?: string;
};

/** What the LLM sees: no URLs (never read aloud), only what it needs to speak. */
function forModel(j: VoiceJob) {
	return {
		rank: j.rank,
		id: j.id,
		title: j.title,
		company: j.company,
		paySpoken: j.paySpoken,
		payIdrMonthly: j.payIdrMonthly,
		eligibility: j.eligibility,
		applicantRegion: j.applicantRegion,
		freshness: j.freshness,
	};
}

async function runTool(
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	if (name === "search_jobs") {
		const query = typeof args.query === "string" ? args.query : "";
		lastQuery = query || null;
		meta.textContent = t.searchingFor(query || "…");
		cards.classList.add("loading");
		try {
			const r = await postTool<SearchResponse>("search_jobs", {
				query,
				remote_usd_only: args.remote_usd_only !== false,
			});
			jobs = r.jobs;
			activeRank = null;
			expandedRank = null;
			speechWindow = [];
			renderCards();
			if (client.active && window.matchMedia("(max-width: 880px)").matches) {
				document.getElementById("jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
			}
			meta.textContent =
				(lastQuery
					? t.resultsFor(lastQuery, r.jobs.length)
					: t.resultsAny(r.jobs.length)) + (r.widened ? ` · ${t.widened}` : "");
			return {
				query: r.query,
				widened: r.widened,
				count: r.jobs.length,
				jobs: r.jobs.map(forModel),
				...(r.note ? { note: r.note } : {}),
			};
		} finally {
			cards.classList.remove("loading");
		}
	}
	if (name === "get_job") {
		const id = typeof args.job_id === "string" ? args.job_id : "";
		const known = jobs.find((j) => j.id === id);
		if (known) {
			expandedRank = known.rank;
			highlight(known.rank);
			renderCards();
		}
		const r = await postTool<{
			job?: VoiceJob;
			error?: string;
			message?: string;
		}>("get_job", { job_id: id });
		if (!r.job) {
			return {
				error: known
					? `Job ${known.rank} (${known.title}) is no longer active. Suggest another job from the list.`
					: `No job with id "${id}". Use an exact id from the latest search_jobs result.`,
			};
		}
		return {
			...forModel({ ...r.job, rank: known?.rank ?? 0 }),
			applyButtonShownOnScreen: true,
		};
	}
	return { error: `Unknown tool ${name}.` };
}

// ── voice client wiring ──────────────────────────────────────────────────────

const agentText = new Map<string, string>();

const client = new VoiceClient(
	{
		state: (s) => {
			state = s;
			if (s === "listening" && queuedText) {
				const q = queuedText;
				queuedText = null;
				window.setTimeout(() => client.sendText(q), 300);
			}
			renderState();
		},
		userPartial: (id, text) =>
			setBubbleText(bubble(`u:${id}`, "user"), text, true),
		userFinal: (id, text) =>
			setBubbleText(bubble(`u:${id}`, "user"), text, false),
		agentWord: (id, word) => {
			const cur = `${agentText.get(id) ?? ""} ${word}`.trim();
			agentText.set(id, cur);
			setBubbleText(bubble(`a:${id}`, "agent"), cur, true);
			followSpeech(word);
		},
		agentFinal: (id, text, interrupted) => {
			if (!text) return;
			const b = bubble(`a:${id}`, "agent");
			setBubbleText(b, interrupted ? `${text} —` : text, false);
			b.classList.toggle("interrupted", interrupted);
			agentText.delete(id);
		},
		level: (v) =>
			stage.style.setProperty("--lvl", Math.min(1, v * 2.2).toFixed(3)),
		error: (m) => {
			statusEl.textContent = m;
		},
		ended: () => {
			muted = false;
			renderState();
		},
	},
	runTool,
);

function submitText(text: string) {
	const clean = text.trim();
	if (!clean) return;
	if (client.ready) {
		const key = `typed:${Date.now()}`;
		setBubbleText(bubble(key, "user"), clean);
		client.sendText(clean);
	} else {
		queuedText = clean;
		setBubbleText(bubble(`typed:${Date.now()}`, "user"), clean);
		if (!client.active) void client.start(lang);
	}
}

orb.addEventListener("click", () => {
	if (client.active) client.stop();
	else void client.start(lang);
});

muteBtn.addEventListener("click", () => {
	muted = !muted;
	client.setMuted(muted);
	renderState();
});

typebox.addEventListener("submit", (e) => {
	e.preventDefault();
	submitText(typed.value);
	typed.value = "";
});

window.addEventListener("pagehide", () => client.endNow());
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && client.active) client.stop();
});

applyLang();

// Shareable results: /?q=react pre-fills the job list without starting a call.
const initialQuery = new URLSearchParams(location.search)
	.get("q")
	?.trim()
	.slice(0, 60);
if (initialQuery) {
	void runTool("search_jobs", { query: initialQuery }).catch(() => {
		meta.textContent = "";
	});
}
