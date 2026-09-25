import type { Lang } from "./agent-config";

const en = {
	tagline: "Talk to find remote jobs that pay in US dollars.",
	start: "Start talking",
	stop: "End call",
	mute: "Mute",
	unmute: "Unmute",
	idle: "Tap to start. Speak English or mix in Bahasa.",
	connecting: "Connecting…",
	listening: "Listening",
	thinking: "Searching…",
	speaking: "Speaking",
	error: "Something went wrong",
	typePlaceholder: "Or type: remote React jobs paying USD",
	send: "Send",
	tryLabel: "Try saying",
	examples: [
		"Find me remote React jobs that pay in dollars",
		"Any customer support jobs for Indonesians?",
		"Tell me more about the second one",
	],
	resultsTitle: "Jobs",
	step1: "Tap the mic and say the job you want.",
	step2: "Loker searches ~4,800 live remote jobs open to Indonesians.",
	step3: "Say “tell me more about number two”, or interrupt any time.",
	resultsEmpty:
		"Jobs you ask about will appear here, numbered so you can say “tell me about number two”.",
	searchingFor: (q: string) => `Searching live LokerDollar jobs for “${q}”…`,
	resultsFor: (q: string, n: number) =>
		`${n} live match${n === 1 ? "" : "es"} for “${q}”`,
	resultsAny: (n: number) => `${n} live matches`,
	widened: "No USD-salaried matches, so these may not list pay.",
	salaryNA: "Salary not listed",
	eligibility: {
		id_friendly: "Open to Indonesia",
		unknown: "Location not stated",
		restricted: "Region-locked",
	},
	regionOnly: (r: string) => `${r} applicants only`,
	openJob: "View job",
	apply: "Apply",
	askAbout: "Ask about this",
	askAboutPrompt: (rank: number, title: string, company: string | null) =>
		`Tell me more about number ${rank}, ${title}${company ? ` at ${company}` : ""}.`,
	you: "You",
	agent: "Loker",
	rateNote: "Rupiah ≈ at Rp 16,500/USD, midpoint of range",
	micNote: "Uses your microphone only while a call is active.",
	poweredBy: "Voice by AssemblyAI Voice Agent API · Jobs by LokerDollar",
};

type Strings = typeof en;

const id: Strings = {
	...en,
	tagline: "Ngobrol untuk cari kerja remote bergaji dolar.",
	start: "Mulai bicara",
	stop: "Akhiri",
	mute: "Bisukan",
	unmute: "Nyalakan mic",
	idle: "Tekan untuk mulai. Boleh campur Bahasa & English.",
	connecting: "Menghubungkan…",
	listening: "Mendengarkan",
	thinking: "Mencari…",
	speaking: "Berbicara",
	error: "Terjadi kesalahan",
	typePlaceholder: "Atau ketik: cari kerja remote React bayar dolar",
	send: "Kirim",
	tryLabel: "Coba ucapkan",
	examples: [
		"Cari kerja remote React yang bayar dolar",
		"Ada lowongan customer support remote?",
		"Tell me more about nomor dua",
	],
	resultsTitle: "Lowongan",
	step1: "Tekan mic dan sebutkan pekerjaan yang kamu cari.",
	step2: "Loker mencari ~4.800 lowongan remote aktif yang terbuka untuk Indonesia.",
	step3: "Bilang “nomor dua” untuk detail, atau potong kapan saja.",
	resultsEmpty:
		"Lowongan akan muncul di sini, bernomor, jadi kamu bisa bilang “nomor dua”.",
	searchingFor: (q: string) => `Mencari lowongan LokerDollar untuk “${q}”…`,
	resultsFor: (q: string, n: number) => `${n} lowongan aktif untuk “${q}”`,
	resultsAny: (n: number) => `${n} lowongan aktif`,
	widened:
		"Tidak ada yang mencantumkan gaji USD, jadi hasil ini mungkin tanpa gaji.",
	salaryNA: "Gaji tidak dicantumkan",
	eligibility: {
		id_friendly: "Terbuka untuk Indonesia",
		unknown: "Lokasi tidak disebut",
		restricted: "Terbatas wilayah",
	},
	regionOnly: (r: string) => `Khusus pelamar ${r}`,
	openJob: "Lihat",
	apply: "Lamar",
	askAbout: "Tanya ini",
	askAboutPrompt: (rank: number, title: string, company: string | null) =>
		`Ceritakan lebih lanjut tentang nomor ${rank}, ${title}${company ? ` di ${company}` : ""}.`,
	you: "Kamu",
	rateNote: "Rupiah ≈ kurs Rp 16.500/USD, titik tengah rentang",
	micNote: "Mikrofon hanya dipakai saat panggilan aktif.",
	poweredBy:
		"Suara oleh AssemblyAI Voice Agent API · Lowongan oleh LokerDollar",
};

export const STRINGS: Record<Lang, Strings> = { en, id };
export type { Strings };
