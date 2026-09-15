# YouTube Shorts Publishing Design

## Goal

Automatically publish every rendered reel to YouTube as a Short, with no human approval step, reusing the caption already generated for Instagram. Second of several planned platform integrations — this slice also introduces the fan-out point every future platform branches from.

## Scope of this slice

- Introduces a single junction node in the `Research and Render Local AI Reel` n8n workflow that all platform-publish branches fan out from. Adding a new platform later means adding one more branch off this node — nothing upstream changes.
- Renames the existing `Route Instagram Caption Result` node to `Caption Ready` to reflect that it's now a shared, platform-neutral junction, not an Instagram-only step. No output shape or logic change — same `{caption, captionSource, outputLocation}`. No other node references it by name, so this is a safe no-op besides the connections.
- Adds one new renderer endpoint that owns the YouTube Data API v3 resumable upload flow.
- Adds one new n8n branch off `Caption Ready`: `Build YouTube Metadata` → `Publish to YouTube`.
- Does not add a human-review gate — same override as Instagram.
- Does not add a separate Claude call for YouTube title/description — title is derived in code from the existing topic data, description reuses the Instagram caption (+ `#Shorts` if not already present).
- Does not cover other platforms (TikTok, etc.) in this slice, but the junction node is what makes adding them a small diff.
- Does not use a community n8n node — OAuth + upload flow stays in code we own.

## Pipeline additions (n8n)

### 0. Rename `Route Instagram Caption Result` → `Caption Ready`

Same code, same output. This becomes the fan-out point:

```
Caption Ready ──┬─→ Publish to Instagram
                ├─→ Build YouTube Metadata → Publish to YouTube
                └─→ (future platform) Build <X> Metadata → Publish to <X>
```

### 1. `Build YouTube Metadata`

Code node, branches off `Caption Ready`. Re-reads the same run context `Build Instagram Caption Prompt` already reads (`$items('Build Dialogue Audio and Subtitle Render Job')[0].json`) to get `topic.tool_name` / `topic.hook`, no new Claude call:

- `title` = `` `${topic.tool_name ?? topic.topic ?? 'AI Tool'}: ${topic.hook ?? ''}` `` trimmed, truncated to YouTube's 100-char title limit (with a trailing `…` if truncated).
- `description` = `$json.caption` (from `Caption Ready`) with `\n\n#Shorts` appended, unless the caption already contains `#Shorts` (case-insensitive).

Output: `{title, description, outputLocation}`.

### 2. `Publish to YouTube`

HTTP node: `POST http://renderer:3001/v1/publish/youtube`, body `{outputLocation, title, description}`. `neverError: false` — matches every other stage: a publish failure fails the execution loudly. Timeout generous (e.g. 180000ms) to cover the upload.

Response: `{videoId, url}`.

## Renderer: `POST /v1/publish/youtube`

New module `renderer/src/publish-youtube.mjs`, thin route in `server.mjs`, same shape as `publish-instagram.mjs`.

**Request:** `{outputLocation: string, title: string, description: string}`

**Why this differs from Instagram:** the YouTube Data API takes OAuth2 (not a long-lived system token) and wants the raw video bytes via a resumable upload session, not a fetchable URL. The renderer container already has the finished file on disk at `outputLocation` (same `/output` volume used for the static route), so there's no need for `PUBLIC_MEDIA_BASE_URL` or a public tunnel for this platform.

**Flow:**

1. `refreshAccessToken` — `POST https://oauth2.googleapis.com/token` with `client_id`/`client_secret`/`refresh_token`/`grant_type=refresh_token` → `access_token`.
2. `stat(outputLocation)` for the byte size the upload session needs up front.
3. `initiateUpload` — `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, headers `Authorization: Bearer <token>`, `X-Upload-Content-Type: video/mp4`, `X-Upload-Content-Length: <size>`; body `{snippet: {title, description, tags: ['Shorts']}, status: {privacyStatus: YOUTUBE_PRIVACY_STATUS || 'public', selfDeclaredMadeForKids: false}}` → resumable session URL from the `Location` response header.
4. `uploadVideoBytes` — `PUT` the file's bytes (`readFile(outputLocation)`) to that session URL, `Content-Type: video/mp4` → response JSON has `{id: videoId}`.
5. Build `url` = `` `https://youtube.com/shorts/${videoId}` ``.

**Response:** `{videoId, url}`.

**Errors:** `YOUTUBE_NOT_CONFIGURED` (missing env), `YOUTUBE_TOKEN_ERROR:<status>:<message>` (OAuth refresh failed), `YOUTUBE_API_ERROR:<status>:<message>` (session init failed), `YOUTUBE_UPLOAD_SESSION_MISSING` (no `Location` header), `YOUTUBE_UPLOAD_ERROR:<status>:<message>` (upload failed or no `id` in response). The route returns a 4xx, n8n's HTTP node surfaces it as a failed execution — same required, fail-loud behavior as Instagram.

Each step (`refreshAccessToken`, `initiateUpload`, `uploadVideoBytes`) is a small, separately testable function taking an injectable `fetch`, plus the orchestrator takes an injectable `fs` (`{readFile, stat}`) — same pattern as `publish-instagram.mjs`'s injectable `fetch`.

## Config

New vars in `.env.prod` / `.env.example` (same convention as `INSTAGRAM_*`):

| Var | Purpose |
|---|---|
| `YOUTUBE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `YOUTUBE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `YOUTUBE_REFRESH_TOKEN` | Long-lived refresh token for the target channel, minted once via a one-time consent flow |
| `YOUTUBE_PRIVACY_STATUS` | Defaults to `public` if unset |

No `docker-compose.yml` change — `.env.prod` already passes through to both `n8n` and `renderer` via `env_file`.

## Setup required before this can run for real

Manual, browser-based, one-time — not automatable from here:

1. Create a project in Google Cloud Console, enable the **YouTube Data API v3**.
2. Configure the OAuth consent screen (Testing mode is fine for a single channel; add the channel's Google account as a test user).
3. Create an OAuth 2.0 Client ID (type: Desktop app) → gives `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`.
4. Run a one-time authorization: open the Google OAuth consent URL with scope `https://www.googleapis.com/auth/youtube.upload`, sign in as the target channel, approve, capture the `code` param, exchange it at the token endpoint for a `refresh_token`. (I'll write exact commands/URLs for this step when implementation lands, since it needs your own browser + login — I can't do it for you.)
5. Put the resulting `client_id` / `client_secret` / `refresh_token` into `.env.prod`.

## Error handling

No retries anywhere in this flow, matching Instagram. A bad refresh token, an API error on session init, or a failed upload all throw and the n8n execution shows Error. Nothing silently swallowed, nothing auto-retried into a possible duplicate upload.

## Testing

- `renderer/src/publish-youtube.test.mjs`: unit tests for `buildTitle` (truncation), `buildDescription` (`#Shorts` append/dedupe), `refreshAccessToken`, `initiateUpload` (including missing-`Location`-header), `uploadVideoBytes` (including missing-`id`), and the `publishToYouTube` orchestrator — all against a mocked `fetch` and mocked `fs`, no real network or disk I/O.
- `n8n/workflows/research-workflow.test.mjs`: tests for `Build YouTube Metadata`'s title/description logic, mirroring the existing caption-router tests.

## Deployment

Same as Instagram: deployed to the user's own server (reachable via `ssh mac-agent`), not just local. Once built: set the four new env vars in that server's `.env.prod`, rebuild/restart the `renderer` and `n8n` containers there, and re-publish the updated workflow into that server's n8n instance.

## Acceptance criteria

1. A completed render triggers both the Instagram and YouTube branches off `Caption Ready`, with no manual step in between.
2. The YouTube title is derived from the topic (no extra Claude call); the description reuses the Instagram caption + hashtags with `#Shorts` ensured present.
3. The published video is uploaded as public (or whatever `YOUTUBE_PRIVACY_STATUS` is set to) via the resumable upload API.
4. Any failure in the OAuth refresh, session init, or upload fails the n8n execution visibly — no silent partial success, matching the "required" behavior already used for Instagram.
5. `publish-youtube.mjs`'s API interaction logic is unit tested without hitting the real network or real disk.
6. Adding a third platform later requires only: one new renderer publish module + route, one new `Build <X> Metadata` → `Publish to <X>` branch off `Caption Ready` — no changes to the Instagram or YouTube branches, no changes upstream of `Caption Ready`.
