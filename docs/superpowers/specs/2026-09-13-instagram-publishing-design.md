# Instagram Publishing Design

## Goal

Automatically publish every rendered reel to Instagram as a Reel, with no human approval step, including an AI-written caption and hashtags. First of several planned platform integrations.

## Scope of this slice

- Appends three steps to the existing `Research and Render Local AI Reel` n8n workflow, after `Render 9:16 Reel with Subtitles`.
- Adds one new renderer endpoint that owns the Instagram Graph API's multi-step publish flow.
- Adds one new renderer static route so the finished video is reachable by URL.
- Does not add a human-review gate — the project's stated "human review required" policy is explicitly overridden for this feature per user decision.
- Does not cover other platforms (TikTok, YouTube Shorts, etc.) — Instagram only, first.
- Does not use a community n8n node — the Instagram access token and posting flow stay in code we own, not a third-party package.

## Pipeline additions (n8n)

Three new nodes, appended after `Render 9:16 Reel with Subtitles`:

### 1. `Write Instagram Caption with Claude`

HTTP node, same auth pattern as `Research with Claude` / `Write Peter and Stewie Dialogue with Claude` (`x-api-key: {{$env.ANTHROPIC_API_KEY}}`, `anthropic-version`, model from `$env.ANTHROPIC_MODEL`). `neverError: true` so a bad response routes through the next node instead of hard-failing.

Prompt includes: `tool_name`, `hook`, `one_line_value`, the six dialogue lines, and the existing `seo_brief` (already generated during research — `primary_keyword`, `related_keywords`, `hashtags`). Asks for:

```json
{"caption": "short, punchy Instagram caption, no hashtags inline", "hashtags": ["#Tag1", "#Tag2"]}
```

5-8 hashtags, reusing `seo_brief.hashtags` as a baseline the model can adjust rather than inventing from scratch.

### 2. `Route Instagram Caption Result`

Code node, same shape as `Route Claude Dialogue Result`. On success, joins caption + hashtags into one string (Instagram's API takes a single text field — no separate hashtags param) and sets `use_seo_fallback: false`. On any failure (HTTP error, empty response, invalid JSON, missing `caption`/`hashtags`), builds the caption directly from the existing `seo_brief.description` + `seo_brief.hashtags` and sets `use_seo_fallback: true`. This fallback needs no new API calls or infrastructure — that data already exists on every run.

Output: `{caption: "<final combined text>", captionSource: 'claude' | 'seo_fallback'}`.

### 3. `Publish to Instagram`

HTTP node: `POST http://renderer:3001/v1/publish/instagram`, body `{outputLocation, caption}` where `outputLocation` comes from the `Render 9:16 Reel with Subtitles` response. `neverError: false` — a publish failure should fail the execution loudly, matching how every other stage in this pipeline behaves. Timeout generous (e.g. 180000ms) to cover Instagram's processing poll.

Response: `{mediaId, permalink}`, available in the execution output for whoever checks the run.

## Renderer: `POST /v1/publish/instagram`

New module `renderer/src/publish-instagram.mjs`, thin route in `server.mjs`, same shape as the existing `/v1/render` / `/v1/visuals` handlers.

**Request:** `{outputLocation: string, caption: string}`

**Flow** (Meta Graph API, version from `INSTAGRAM_GRAPH_API_VERSION`):

1. Build `video_url` = `${PUBLIC_MEDIA_BASE_URL}/output/${basename(outputLocation)}`.
2. `POST /{INSTAGRAM_BUSINESS_ACCOUNT_ID}/media` — `{media_type: 'REELS', video_url, caption, access_token}` → `{id: creationId}`.
3. Poll `GET /{creationId}?fields=status_code&access_token=...` every 5s, up to a 150s budget. Stop on `FINISHED` (proceed), `ERROR` / `EXPIRED` (throw), or budget exceeded (throw timeout).
4. `POST /{INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish` — `{creation_id: creationId, access_token}` → `{id: mediaId}`.
5. `GET /{mediaId}?fields=permalink&access_token=...` → `{permalink}`.

**Response:** `{mediaId, permalink}`.

**Errors:** any non-2xx from Meta, an `ERROR`/`EXPIRED` status, or a poll timeout throws with a specific message (`INSTAGRAM_CONTAINER_ERROR`, `INSTAGRAM_POLL_TIMEOUT`, etc.) — the route returns a 4xx/5xx, n8n's HTTP node surfaces it as a failed execution.

The Graph API calls and the polling loop are written as small, separately testable functions (e.g. `createContainer`, `pollUntilFinished`, `publishContainer`, `getPermalink`), each taking an injectable `fetch` so tests never hit the real network — same pattern as `getPublic` in `asset-discovery.mjs`.

## Renderer: static `/output` route

`server.mjs` gets one new line, mirroring the existing `/media` static route:

```js
app.use('/output', express.static(process.env.OUTPUT_ROOT ?? '/output', {dotfiles: 'deny', fallthrough: false}));
```

A Cloudflare Tunnel hostname (e.g. `media.dextron04.in`) is pointed at the renderer container's port 3001, restricted to the `/output` path where the tunnel config allows it, so Instagram's servers can fetch the finished reel by URL.

## Config

New vars in `.env.prod` (same convention as `ANTHROPIC_API_KEY`, `TTS_API_KEY`):

| Var | Purpose |
|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived token, `instagram_content_publish` permission |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | IG Business Account numeric ID |
| `INSTAGRAM_GRAPH_API_VERSION` | Defaults to current stable (e.g. `v21.0`) if unset |
| `PUBLIC_MEDIA_BASE_URL` | e.g. `https://media.dextron04.in` — base for the public `video_url` |

## Setup required before this can run for real

1. Create a Meta Developer App (Business type) at developers.facebook.com.
2. Add the Instagram Graph API product to it.
3. Add the target Instagram account as a tester on the app (keeps it in Development mode — no App Review needed for personal/single-account use).
4. Generate a User token with `instagram_basic` + `instagram_content_publish` (+ `pages_show_list`, `business_management`), then exchange it for a long-lived token (~60 days; needs periodic refresh — not automated in this slice).
5. Fetch the IG Business Account ID via `GET /me/accounts` → the linked Page → `GET /{page-id}?fields=instagram_business_account`.
6. Add the Cloudflare Tunnel route for `PUBLIC_MEDIA_BASE_URL` → renderer:3001.

This is manual, browser-based setup on Meta's own dashboards — not something automatable from here.

## Error handling

No retries anywhere in this flow. A stuck/errored container, a poll timeout, a bad token, or a Meta rate limit all throw and the n8n execution shows Error — consistent with how a bad dialogue or a search failure already behaves in this pipeline. Nothing is silently swallowed; nothing gets auto-retried into a possible duplicate post.

## Testing

- `renderer/src/publish-instagram.test.mjs`: unit tests for `createContainer`, `pollUntilFinished` (including the `ERROR`/`EXPIRED`/timeout paths), `publishContainer`, `getPermalink`, and the `video_url` builder — all against a mocked `fetch`, no real network calls.
- `n8n/workflows/research-workflow.test.mjs`: tests for the caption prompt builder and `Route Instagram Caption Result`'s success/fallback branches, mirroring the existing dialogue-router tests.

## Deployment

This is deployed to the user's own server (reachable via `ssh mac-agent`), not just run locally. Once this spec is approved and built, deployment means: set the four new env vars in that server's `.env.prod`, add the Cloudflare Tunnel route, rebuild/restart the `renderer` and `n8n` containers there, and re-publish the updated workflow into that server's n8n instance the same way it was patched locally in this session.

## Acceptance criteria

1. A completed render triggers caption generation, then publish, with no manual step in between.
2. If Claude's caption call fails for any reason, the run still publishes, using the `seo_brief`-derived caption instead.
3. The published post is a Reel (not a feed video or image), with the generated caption and hashtags.
4. Any Graph API failure (container error, timeout, publish failure) fails the n8n execution visibly — no silent partial success.
5. `publish-instagram.mjs`'s Graph API interaction logic is unit tested without hitting the real network.
