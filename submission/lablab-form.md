# lablab.ai submission form

**Project title**
LokerDollar Voice

**Short description (≤255 chars)**
A real-time voice agent that helps Indonesian workers find remote jobs paying US dollars. Talk, interrupt, and ask about "the second one". It searches ~4,800 live jobs and shows pay in rupiah. Built on the AssemblyAI Voice Agent API.

<!-- 233 characters -->

**Long description**
Remote jobs that pay in US dollars can earn an Indonesian worker about seven times Jakarta's minimum wage, but they are hard to find. Most "remote" listings quietly exclude Asia. Salaries are quoted in dollars per year, a unit nobody here budgets in. And searching means typing English filters, while many capable people think in Bahasa Indonesia.

LokerDollar Voice lets you simply talk. Say "find me remote customer support jobs that pay in dollars" and the agent searches LokerDollar's live database of about 4,800 open remote jobs filtered for Indonesian applicants. Numbered job cards appear on screen as the agent starts answering, and it reads the top three with pay. Ask "tell me more about the second one" and it fetches that job, tells you the pay in rupiah per month and whether Indonesians can apply, and highlights the Apply button. You can cut in at any time: the agent stops mid-sentence and follows your new request.

How it uses AssemblyAI: the whole conversation (Universal-3.5 Pro streaming speech-to-text, the LLM, text-to-speech, turn detection, and barge-in) runs over one AssemblyAI Voice Agent API WebSocket. A Cloudflare Worker mints single-use temporary tokens, so the API key never reaches the browser. The agent is configured inline with one session.update. Job search and job details are client-side function tools: the browser runs them against the Worker, renders the cards, and returns tool.result exactly when reply.done is the latest event, following the docs. Key terms and a transcription prompt bias recognition toward job titles, tech stacks, and mixed Indonesian-English phrases. The agent's word-level transcript (transcript.agent.delta) lights up the card it is talking about. Typed questions and "Ask about this" card taps go into the same voice conversation through conversation.message and reply.create.

Every result is real: jobs come from LokerDollar's production database through its public MCP server, and every Apply link goes to a real listing.

Honest limitation: AssemblyAI does not support Indonesian speech yet. The agent understands mixed Indonesian-English and typed Indonesian, and replies in simple English. Next steps: a phone line over AssemblyAI SIP for workers without laptops, mock interview practice, and native Bahasa once it is supported.

**Tags / technologies**
AssemblyAI, Voice Agent API, Universal-3.5 Pro Streaming, Speech-to-Text, Text-to-Speech, Voice AI, Function Calling, Tool Use, Real-time, WebSocket, Cloudflare Workers, TypeScript, Vite, MCP, Jobs, Future of Work, Indonesia, Remote Work

**Category**
Voice agent / Future of work

**Links**
- Demo: https://lokerdollar-voice-agent.kelvin-6d2.workers.dev
- Repo: https://github.com/kelvindesman/lokerdollar-voice-agent
- Slides: submission/slides.pdf (upload the PDF)
- Cover image: submission/cover.png (1920×1080, 16:9)
- Video: record from submission/video-script.md, upload to YouTube (unlisted is fine), paste the link
