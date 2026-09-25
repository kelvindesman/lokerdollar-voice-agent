# Demo video script (target 2:30, hard cap 3:00)

**Setup before recording**
- Chrome, window at 1440×900, zoom 100%. Open https://lokerdollar-voice-agent.kelvin-6d2.workers.dev and grant mic permission once, so the prompt does not appear on camera.
- Record the screen **and system audio** (the agent's voice must be heard). On macOS, QuickTime alone cannot capture system audio: use OBS with an audio loopback, or Loom/Screen Studio.
- Use a headset mic or a quiet room. Speakers are fine, because the browser's echo cancellation stops the agent from hearing itself.
- Do one practice run first: the first session after a deploy can take a second longer to connect.

| # | Time | Screen | What you say / do |
|---|------|--------|-------------------|
| 1 | 0:00–0:15 | Cover slide (submission/cover.png) | "Remote jobs paying US dollars can earn an Indonesian worker about seven times the local minimum wage. But the job boards are built for Americans, pay is in dollars per year, and searching means typing English filters. So I built LokerDollar Voice: you just talk." |
| 2 | 0:15–0:25 | App, idle | "It runs on the AssemblyAI Voice Agent API and searches LokerDollar's live database of about 4,800 remote jobs open to Indonesians." Click the green mic. The agent greets you. |
| 3 | 0:25–0:55 | Cards appear | Say: **"Find me remote customer support jobs that pay in dollars."** Point out: your words appear live as you speak; the cards appear while the agent says "let me check"; the card lights up as the agent reads each job; every card shows a rupiah estimate per month. |
| 4 | 0:55–1:20 | Card #2 highlighted | Say: **"Tell me more about the second one."** The agent calls `get_job`, gives pay in rupiah, and says whether Indonesians can apply. The Apply button on card 2 turns green. |
| 5 | 1:20–1:40 | Barge-in | While the agent is still talking, cut in: **"Wait, actually, show me React developer jobs."** It stops mid-sentence (✋ on the caption) and starts a new search. Say: "Interruptions work like a normal conversation, and the audio stops right away." |
| 6 | 1:40–1:55 | Mixed language | Toggle **ID**. Say: **"Cari kerja remote designer yang bayar dolar."** (If recognition struggles, say "designer jobs" in English and explain the Indonesian limitation honestly; see the note below.) |
| 7 | 1:55–2:05 | Tap card | Tap **Ask about this** on a card: "Touch and voice share one conversation." |
| 8 | 2:05–2:30 | Slide 4 (architecture) | "Under the hood: a Cloudflare Worker mints single-use AssemblyAI tokens, so the API key never reaches the browser. The search tools run in the browser as client-side function tools, which is why the cards appear before the agent speaks. Key terms bias recognition toward job titles and tech names, and the agent's word-level transcript lights up the card it's talking about." |
| 9 | 2:30–2:45 | Click **Apply** | Opens the real LokerDollar job page. "Every answer is live data and ends at a real Apply link. Next: a phone line over AssemblyAI SIP for workers without a laptop, and native Bahasa once AssemblyAI supports it." End on the cover. |

**Note on Bahasa Indonesia:** AssemblyAI's streaming speech-to-text does not list Indonesian yet. Mixed sentences with English job words usually work because of key terms. Fully Indonesian sentences may not be transcribed well. Say this on camera instead of hiding it; judges reward honesty more than a demo that fails.

**Backup if the live mic fails during recording:** type into the box ("remote React jobs paying USD"). It uses the same voice session and the agent still answers aloud.
