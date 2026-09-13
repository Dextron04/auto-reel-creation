# Local AI Reel Automation

Local 9:16 reel pipeline using n8n for orchestration and Remotion for rendering.

## Current milestone

The workflow researches current AI developer tools, creates a 30-second Peter–Stewie dialogue, generates both local voices, and renders a 1080×1920 reel with short word-highlighted subtitles. After script generation it collects relevant identity, interface, mechanism, and outcome images from product, documentation and article pages, supplemented by Wikimedia Commons image search. Peter and Stewie PNG cutouts switch with the active voice. A transparent PNG overlay remains optional.

## Run

1. Fill in `.env.prod` with your Anthropic API key, Cloudflare Access credentials, and TTS API key.
2. Place the source video at `media/source.mp4`.
3. Place optional voice audio and PNG overlay under `media/`.
4. Start with `docker compose up --build`.
5. Open n8n at http://localhost:5678 and import `n8n/workflows/research-and-render-reel.json`.
6. Run the workflow. Rendered files appear in `output/`.

The renderer health endpoint is http://localhost:3001/health. Platform publishing is intentionally not included yet.

## Research workflow

Import `n8n/workflows/research-and-render-reel.json` into n8n. The research trigger is configured for 09:00 and 17:00 in the n8n timezone. Before activating it, provide `ANTHROPIC_API_KEY`, `OLLAMA_CF_ACCESS_CLIENT_ID`, and `OLLAMA_CF_ACCESS_CLIENT_SECRET` to the n8n container environment, or replace the header expressions with n8n credentials.

The research stage combines 10 feeds from OpenAI, Google AI, Hugging Face, GitHub, DEV, Product Hunt, AWS, Vercel, and JetBrains. It deduplicates and scores releases for recency, developer relevance, source authority, cross-source momentum, and useful SEO terms before sending the top signals to Claude through Anthropic's Messages API. `ANTHROPIC_MODEL` defaults to the low-latency `claude-haiku-4-5-20251001`; set it to `claude-sonnet-5` if you prefer deeper synthesis. If Claude returns an HTTP error (including exhausted credits or rate limits), an Anthropic error payload, or empty output, the workflow automatically retries the same research prompt with local `tushin-agent:latest` at `https://ollama.dextron04.in/api/generate`.

The research model must return five evidence-backed candidates, one recommended topic, exact source URLs, and an SEO brief. Claude then writes six alternating Peter and Stewie turns totaling roughly 55–68 words; dialogue generation uses the same automatic local-Qwen fallback policy as research. Each turn is sent to the matching configured voice and saved separately. The renderer measures the actual WAV durations, sequences the dialogue without overlap, and gently accelerates it only when necessary to stay within 29.5 seconds.

Subtitle groups contain no more than four words. Peter's active word is yellow and Stewie's active word is red, while inactive words remain white. Qwen plans 4–8 image queries anchored to phrases in the completed script. The n8n node `Find and Download Script Images` calls the renderer's `/v1/visuals` collector, which extracts relevant page images, searches Commons, validates and converts selected images, and records sources in `/media/visuals/<run>/manifest.json`. Collection failures are reported and skipped. Images appear above middle-screen captions, fade in and out, and change at phrase cues without added title cards. Phrase timing uses the existing estimated caption tokens; it is not forced audio alignment. Web relevance and image rights still require editorial review. This collector does not search Google/Bing or capture interactive website screenshots. Configure `TTS_PETER_VOICE` and `TTS_STEWIE_VOICE` (plus their optional reference IDs) in `.env.prod`. Human review remains required before publication, and platform publishing is not included.
