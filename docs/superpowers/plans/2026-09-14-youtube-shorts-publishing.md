# YouTube Shorts Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a reel finishes rendering, automatically upload it to YouTube as a Short — title derived from the topic, description reusing the Instagram caption + hashtags — with no human approval step, and introduce a shared `Caption Ready` junction node so future platforms are additive.

**Architecture:** Rename the existing `Route Instagram Caption Result` n8n node to `Caption Ready` (same output, no logic change) and give it a second outgoing branch: `Build YouTube Metadata` → `Publish to YouTube`, parallel to the existing `Publish to Instagram` branch. `Build YouTube Metadata` derives the title/description in code — no new Claude call. `Publish to YouTube` calls a new renderer endpoint (`renderer/src/publish-youtube.mjs`, routed in `server.mjs`) that owns the YouTube Data API v3's OAuth-refresh → resumable-upload-session → upload-bytes flow, reading the rendered file directly off the renderer's local `/output` volume (no public URL needed, unlike Instagram).

**Tech Stack:** Node.js 22 (global `fetch`, `node:fs/promises`, no new npm dependency), Express (existing), n8n Code/HTTP Request nodes, `node:test`.

## Global Constraints

- No human approval gate — publishing is fully automatic, same override as Instagram.
- No community n8n nodes for YouTube — all Data API logic is our own code, in the renderer, so OAuth credentials never run through third-party code.
- No retries anywhere in the publish flow — any failure (bad refresh token, session-init error, upload error) throws and the n8n execution shows Error, matching Instagram and every other stage of this pipeline.
- Target format is a YouTube **Short**: vertical video, title/description carry `#Shorts`, `tags: ['Shorts']` — no separate "is this a Short" flag exists in the API; YouTube infers it from aspect ratio/duration plus the tag/hashtag signal.
- New env vars, read only inside the renderer container: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_PRIVACY_STATUS` (default `public` if unset).
- The YouTube branch is **required**, not optional: if `YOUTUBE_*` env vars are missing or the upload fails, the whole n8n execution fails — same "required" philosophy as Instagram, per explicit user decision.
- No extra Claude call for YouTube metadata — title is derived in code from `topic.tool_name`/`topic.hook` (truncated to YouTube's 100-character title limit), description reuses the already-generated Instagram caption + hashtags with `#Shorts` appended if not already present.
- Deployment target is the user's own server, reachable via the SSH alias `mac-agent` — not just this local Docker Desktop setup. The last task in this plan deploys there.

---

### Task 1: Renderer — YouTube Data API publish module

**Files:**
- Create: `renderer/src/publish-youtube.mjs`
- Test: `renderer/src/publish-youtube.test.mjs`

**Interfaces:**
- Produces: `buildTitle(topic?)`, `buildDescription(caption)`, `buildShortsUrl(videoId)`, `refreshAccessToken({clientId, clientSecret, refreshToken}, fetchImpl?)`, `initiateUpload({accessToken, title, description, privacyStatus, fileSizeBytes}, fetchImpl?)`, `uploadVideoBytes({uploadUrl, videoBuffer}, fetchImpl?)`, `publishToYouTube({outputLocation, title, description}, fetchImpl?, fsImpl?)` — the last is what Task 2's route calls. All async functions return Promises; all throw `Error` with a specific message on failure (see step 3's code for exact messages).

- [ ] **Step 1: Write the failing tests**

Create `renderer/src/publish-youtube.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {buildTitle, buildDescription, buildShortsUrl, refreshAccessToken, initiateUpload, uploadVideoBytes, publishToYouTube} from './publish-youtube.mjs'

const fakeResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: {get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null},
})

test('buildTitle derives a title from the tool name and hook', () => {
  assert.equal(buildTitle({tool_name: 'Agent Kit', hook: 'Stop writing glue code'}), 'Agent Kit: Stop writing glue code')
})
test('buildTitle falls back to topic or a generic label when tool_name is missing', () => {
  assert.equal(buildTitle({topic: 'Agent Kit', hook: 'Stop writing glue code'}), 'Agent Kit: Stop writing glue code')
  assert.equal(buildTitle({hook: 'Stop writing glue code'}), 'AI Tool: Stop writing glue code')
})
test('buildTitle truncates to 100 characters with an ellipsis', () => {
  const hook = 'Stop writing glue code for every coding agent you touch this quarter and beyond, seriously'
  const title = buildTitle({tool_name: 'Agent Kit', hook})
  assert.ok(title.length <= 100)
  assert.ok(title.endsWith('…'))
  assert.ok(title.startsWith('Agent Kit: Stop writing glue code'))
})

test('buildDescription appends #Shorts when missing', () => {
  assert.equal(buildDescription('Stop writing glue code.\n\n#AgentKit #DevTools'), 'Stop writing glue code.\n\n#AgentKit #DevTools\n\n#Shorts')
})
test('buildDescription does not duplicate #Shorts when already present', () => {
  assert.equal(buildDescription('Already has #Shorts in it.'), 'Already has #Shorts in it.')
})

test('buildShortsUrl builds a youtube.com/shorts link', () => {
  assert.equal(buildShortsUrl('abc123'), 'https://youtube.com/shorts/abc123')
})

test('refreshAccessToken returns the access token from a successful response', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({url: String(url), init}); return fakeResponse(200, {access_token: 'tok-1'}) }
  const token = await refreshAccessToken({clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'}, fetchImpl)
  assert.equal(token, 'tok-1')
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token')
  assert.equal(calls[0].init.method, 'POST')
})
test('refreshAccessToken throws on a non-2xx or missing token response', async () => {
  const fetchImpl = async () => fakeResponse(400, {error: 'invalid_grant', error_description: 'Token has been expired or revoked'})
  await assert.rejects(() => refreshAccessToken({clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'}, fetchImpl), /YOUTUBE_TOKEN_ERROR:400:Token has been expired or revoked/)
})

test('initiateUpload returns the resumable session url from the Location header', async () => {
  const fetchImpl = async () => fakeResponse(200, {}, {location: 'https://upload.example.com/session-1'})
  const uploadUrl = await initiateUpload({accessToken: 'tok', title: 't', description: 'd', privacyStatus: 'public', fileSizeBytes: 1024}, fetchImpl)
  assert.equal(uploadUrl, 'https://upload.example.com/session-1')
})
test('initiateUpload throws on a non-2xx response', async () => {
  const fetchImpl = async () => fakeResponse(401, {error: {message: 'invalid credentials'}})
  await assert.rejects(() => initiateUpload({accessToken: 'tok', title: 't', description: 'd', privacyStatus: 'public', fileSizeBytes: 1024}, fetchImpl), /YOUTUBE_API_ERROR:401:invalid credentials/)
})
test('initiateUpload throws when the Location header is missing', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => initiateUpload({accessToken: 'tok', title: 't', description: 'd', privacyStatus: 'public', fileSizeBytes: 1024}, fetchImpl), /YOUTUBE_UPLOAD_SESSION_MISSING/)
})

test('uploadVideoBytes returns the video id from a successful response', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({url: String(url), init}); return fakeResponse(200, {id: 'video-1'}) }
  const videoId = await uploadVideoBytes({uploadUrl: 'https://upload.example.com/session-1', videoBuffer: Buffer.from('fake video bytes')}, fetchImpl)
  assert.equal(videoId, 'video-1')
  assert.equal(calls[0].init.method, 'PUT')
})
test('uploadVideoBytes throws when the response has no id', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => uploadVideoBytes({uploadUrl: 'https://upload.example.com/session-1', videoBuffer: Buffer.from('x')}, fetchImpl), /YOUTUBE_UPLOAD_ERROR:200:no id returned/)
})

test('publishToYouTube runs the full refresh/initiate/upload chain', async () => {
  process.env.YOUTUBE_CLIENT_ID = 'id'
  process.env.YOUTUBE_CLIENT_SECRET = 'secret'
  process.env.YOUTUBE_REFRESH_TOKEN = 'refresh'
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (String(url).includes('oauth2.googleapis.com')) return fakeResponse(200, {access_token: 'tok-1'})
    if (String(url).includes('uploadType=resumable')) return fakeResponse(200, {}, {location: 'https://upload.example.com/session-1'})
    if (String(url).includes('session-1')) return fakeResponse(200, {id: 'video-1'})
    throw new Error(`unexpected url: ${url}`)
  }
  const fsImpl = {
    stat: async () => ({size: 1024}),
    readFile: async () => Buffer.from('fake video bytes'),
  }
  const result = await publishToYouTube({outputLocation: '/output/reel-1.mp4', title: 't', description: 'd'}, fetchImpl, fsImpl)
  assert.deepEqual(result, {videoId: 'video-1', url: 'https://youtube.com/shorts/video-1'})
  assert.equal(urls.length, 3)
})
test('publishToYouTube throws YOUTUBE_NOT_CONFIGURED when env vars are missing', async () => {
  delete process.env.YOUTUBE_CLIENT_ID
  delete process.env.YOUTUBE_CLIENT_SECRET
  delete process.env.YOUTUBE_REFRESH_TOKEN
  await assert.rejects(
    () => publishToYouTube(
      {outputLocation: '/output/reel-1.mp4', title: 't', description: 'd'},
      async () => fakeResponse(200, {}),
      {stat: async () => ({size: 1}), readFile: async () => Buffer.from('x')},
    ),
    /YOUTUBE_NOT_CONFIGURED/
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd renderer && node --test src/publish-youtube.test.mjs`
Expected: FAIL — `Cannot find module './publish-youtube.mjs'`

- [ ] **Step 3: Write the implementation**

Create `renderer/src/publish-youtube.mjs`:

```js
import {readFile, stat} from 'node:fs/promises'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'
const TITLE_MAX_LENGTH = 100

export function buildTitle(topic = {}) {
  const raw = `${topic.tool_name ?? topic.topic ?? 'AI Tool'}: ${topic.hook ?? ''}`.trim()
  return raw.length > TITLE_MAX_LENGTH ? `${raw.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : raw
}

export function buildDescription(caption) {
  const text = String(caption ?? '').trim()
  return /#shorts/i.test(text) ? text : `${text}\n\n#Shorts`.trim()
}

export function buildShortsUrl(videoId) {
  return `https://youtube.com/shorts/${videoId}`
}

export async function refreshAccessToken({clientId, clientSecret, refreshToken}, fetchImpl = fetch) {
  const body = new URLSearchParams({client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token'})
  const response = await fetchImpl(TOKEN_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body})
  const json = await response.json()
  if (!response.ok || !json.access_token) throw new Error(`YOUTUBE_TOKEN_ERROR:${response.status}:${json.error_description || json.error || 'unknown'}`)
  return json.access_token
}

export async function initiateUpload({accessToken, title, description, privacyStatus, fileSizeBytes}, fetchImpl = fetch) {
  const response = await fetchImpl(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(fileSizeBytes),
    },
    body: JSON.stringify({snippet: {title, description, tags: ['Shorts']}, status: {privacyStatus, selfDeclaredMadeForKids: false}}),
  })
  if (!response.ok) {
    const json = await response.json().catch(() => ({}))
    throw new Error(`YOUTUBE_API_ERROR:${response.status}:${json.error?.message || 'unknown'}`)
  }
  const location = response.headers.get('location')
  if (!location) throw new Error('YOUTUBE_UPLOAD_SESSION_MISSING')
  return location
}

export async function uploadVideoBytes({uploadUrl, videoBuffer}, fetchImpl = fetch) {
  const response = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {'Content-Type': 'video/mp4', 'Content-Length': String(videoBuffer.length)},
    body: videoBuffer,
  })
  const json = await response.json()
  if (!response.ok || !json.id) throw new Error(`YOUTUBE_UPLOAD_ERROR:${response.status}:${json.error?.message || 'no id returned'}`)
  return json.id
}

export async function publishToYouTube({outputLocation, title, description}, fetchImpl = fetch, fsImpl = {readFile, stat}) {
  const clientId = process.env.YOUTUBE_CLIENT_ID
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) throw new Error('YOUTUBE_NOT_CONFIGURED')
  const accessToken = await refreshAccessToken({clientId, clientSecret, refreshToken}, fetchImpl)
  const {size: fileSizeBytes} = await fsImpl.stat(outputLocation)
  const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'public'
  const uploadUrl = await initiateUpload({accessToken, title, description, privacyStatus, fileSizeBytes}, fetchImpl)
  const videoBuffer = await fsImpl.readFile(outputLocation)
  const videoId = await uploadVideoBytes({uploadUrl, videoBuffer}, fetchImpl)
  return {videoId, url: buildShortsUrl(videoId)}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd renderer && node --test src/publish-youtube.test.mjs`
Expected: PASS, 15 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add renderer/src/publish-youtube.mjs renderer/src/publish-youtube.test.mjs
git commit -m "$(cat <<'EOF'
Add YouTube Data API publish module

OAuth refresh -> resumable session -> byte upload chain as small
testable functions with an injectable fetch and fs, matching the
publish-instagram.mjs pattern. Reads the rendered file directly off
the renderer's local /output volume instead of needing a public URL.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Renderer — wire the endpoint

**Files:**
- Modify: `renderer/src/server.mjs`

**Interfaces:**
- Consumes: `publishToYouTube({outputLocation, title, description})` from Task 1 (`renderer/src/publish-youtube.mjs`).
- Produces: `POST /v1/publish/youtube` — request body `{outputLocation, title, description}`, success response `{videoId, url}` (HTTP 200), failure response `{error: string}` (HTTP 400).

- [ ] **Step 1: Modify `server.mjs`**

Find this line near the top of `renderer/src/server.mjs`:

```js
import {publishToInstagram, diagnoseInstagramContainer} from './publish-instagram.mjs';
```

Add a new import line directly after it:

```js
import {publishToYouTube} from './publish-youtube.mjs';
```

Find this block:

```js
app.post('/v1/publish/instagram/diagnose', async (req, res) => {
  try { res.json(await diagnoseInstagramContainer(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
```

Add a new route directly after it:

```js
app.post('/v1/publish/youtube', async (req, res) => {
  try { res.json(await publishToYouTube(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
```

- [ ] **Step 2: Run the full renderer test suite to confirm nothing broke**

Run: `cd renderer && npm test`
Expected: PASS, all existing tests plus the 15 from Task 1 still passing

- [ ] **Step 3: Commit**

```bash
git add renderer/src/server.mjs
git commit -m "$(cat <<'EOF'
Wire POST /v1/publish/youtube route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: n8n workflow — Caption Ready fan-out and the YouTube branch

**Files:**
- Modify: `n8n/workflows/research-and-render-reel.json`

**Interfaces:**
- Consumes: `Caption Ready`'s output `{caption: string, captionSource: 'claude' | 'seo_fallback', outputLocation: string}` (same node, renamed — no shape change); `research.recommended_topic` (`tool_name`, `hook`) already present on every item flowing through `Build Dialogue Audio and Subtitle Render Job` (unchanged upstream node).
- Produces: node ids `build-youtube-metadata`, `youtube-publish`. `build-youtube-metadata`'s output shape: `{title: string, description: string, outputLocation: string}`.

- [ ] **Step 1: Rename `Route Instagram Caption Result` to `Caption Ready`**

Find this node in the `nodes` array (id `route-instagram-caption`):

```json
      "id": "route-instagram-caption",
      "name": "Route Instagram Caption Result",
      "type": "n8n-nodes-base.code",
```

Change the `name` field only:

```json
      "id": "route-instagram-caption",
      "name": "Caption Ready",
      "type": "n8n-nodes-base.code",
```

The node's `jsCode` and `id` are unchanged — this is a display-name-only edit. No other node references it by name, so nothing else in the `nodes` array needs to change.

- [ ] **Step 2: Add the two new nodes**

Find the `Publish to Instagram` node (id `instagram-publish`, the block ending right before the `Find and Download Script Images` node):

```json
      "id": "instagram-publish",
      "name": "Publish to Instagram",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        4080,
        0
      ]
    },
```

Insert these two node objects immediately after that closing `},` (still before the `Find and Download Script Images` node):

```json
    {
      "parameters": {
        "jsCode": "const context = $items('Build Dialogue Audio and Subtitle Render Job')[0]?.json ?? {};\nconst topic = context.research?.recommended_topic ?? {};\nconst rawTitle = `${topic.tool_name ?? topic.topic ?? 'AI Tool'}: ${topic.hook ?? ''}`.trim();\nconst title = rawTitle.length > 100 ? `${rawTitle.slice(0, 99).trimEnd()}…` : rawTitle;\nconst caption = String($json.caption ?? '').trim();\nconst description = /#shorts/i.test(caption) ? caption : `${caption}\\n\\n#Shorts`.trim();\nreturn [{ json: { title, description, outputLocation: $json.outputLocation } }];"
      },
      "id": "build-youtube-metadata",
      "name": "Build YouTube Metadata",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        4080,
        200
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://renderer:3001/v1/publish/youtube",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { outputLocation: $json.outputLocation, title: $json.title, description: $json.description } }}",
        "options": {
          "response": {
            "response": {
              "responseFormat": "json"
            }
          },
          "timeout": 180000
        }
      },
      "id": "youtube-publish",
      "name": "Publish to YouTube",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        4320,
        200
      ]
    },
```

- [ ] **Step 3: Rewire the connections**

Find this in the `connections` object (the tail end of the file):

```json
    "Write Instagram Caption with Claude": {
      "main": [
        [
          {
            "node": "Route Instagram Caption Result",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Route Instagram Caption Result": {
      "main": [
        [
          {
            "node": "Publish to Instagram",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
```

Replace it with:

```json
    "Write Instagram Caption with Claude": {
      "main": [
        [
          {
            "node": "Caption Ready",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Caption Ready": {
      "main": [
        [
          {
            "node": "Publish to Instagram",
            "type": "main",
            "index": 0
          },
          {
            "node": "Build YouTube Metadata",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Build YouTube Metadata": {
      "main": [
        [
          {
            "node": "Publish to YouTube",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
```

The two objects inside `"Caption Ready"`'s single `main[0]` array is what fans the one output pin out to both platform branches in parallel — this is the pattern any future platform branch also joins.

- [ ] **Step 4: Validate the JSON**

Run: `python3 -c "import json; json.load(open('n8n/workflows/research-and-render-reel.json')); print('valid JSON')"`
Expected: `valid JSON`

- [ ] **Step 5: Commit**

```bash
git add n8n/workflows/research-and-render-reel.json
git commit -m "$(cat <<'EOF'
Add Caption Ready fan-out and the YouTube publish branch

Rename Route Instagram Caption Result -> Caption Ready (same output,
no logic change) and give it a second parallel branch: Build YouTube
Metadata -> Publish to YouTube, alongside the existing Publish to
Instagram branch. Title is derived from the topic in code; description
reuses the already-generated Instagram caption. Any future platform
joins the same Caption Ready fan-out.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: n8n workflow — tests for the fan-out and the metadata builder

**Files:**
- Modify: `n8n/workflows/research-workflow.test.mjs`

**Interfaces:**
- Consumes: `nodeById` map and `workflow.connections` (already defined at the top of the test file), node ids `route-instagram-caption` and `build-youtube-metadata`, node name `Caption Ready` from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to the end of `n8n/workflows/research-workflow.test.mjs`:

```js
test('Caption Ready fans out to every publish platform branch', () => {
  assert.equal(nodeById.get('route-instagram-caption').name, 'Caption Ready');
  const targets = workflow.connections['Caption Ready'].main[0].map((edge) => edge.node);
  assert.deepEqual(targets, ['Publish to Instagram', 'Build YouTube Metadata']);
  assert.equal(workflow.connections['Write Instagram Caption with Claude'].main[0][0].node, 'Caption Ready');
  assert.equal(workflow.connections['Build YouTube Metadata'].main[0][0].node, 'Publish to YouTube');
});

test('YouTube metadata builder derives a truncated title and reuses the Instagram caption as the description', () => {
  const metadataNode = nodeById.get('build-youtube-metadata');
  assert.ok(metadataNode, 'missing build-youtube-metadata node');
  const context = {json: {research: {recommended_topic: {
    tool_name: 'Agent Kit',
    hook: 'Stop writing glue code for every coding agent you touch this quarter and beyond, seriously',
  }}}};
  const items = () => [context];

  const withoutShorts = new Function('$json', '$items', metadataNode.parameters.jsCode)(
    {caption: 'Stop writing glue code.\n\n#AgentKit #DevTools', outputLocation: '/output/reel-1.mp4'}, items,
  );
  assert.equal(withoutShorts.length, 1);
  assert.ok(withoutShorts[0].json.title.startsWith('Agent Kit: Stop writing glue code'));
  assert.ok(withoutShorts[0].json.title.length <= 100);
  assert.match(withoutShorts[0].json.description, /#AgentKit #DevTools/);
  assert.match(withoutShorts[0].json.description, /#Shorts$/);
  assert.equal(withoutShorts[0].json.outputLocation, '/output/reel-1.mp4');

  const withShorts = new Function('$json', '$items', metadataNode.parameters.jsCode)(
    {caption: 'Already has #Shorts in it.', outputLocation: '/output/reel-1.mp4'}, items,
  );
  assert.equal((withShorts[0].json.description.match(/#Shorts/gi) || []).length, 1);
});

test('Publish to YouTube posts to the renderer and fails the run loudly like Instagram', () => {
  const publishNode = nodeById.get('youtube-publish');
  assert.ok(publishNode, 'missing youtube-publish node');
  assert.equal(publishNode.parameters.url, 'http://renderer:3001/v1/publish/youtube');
  assert.notEqual(publishNode.parameters.options.neverError, true, 'a publish failure must fail the execution, not be swallowed');
  assert.equal(publishNode.parameters.options.timeout, 180000);
  assert.match(publishNode.parameters.jsonBody, /outputLocation/);
  assert.match(publishNode.parameters.jsonBody, /title/);
  assert.match(publishNode.parameters.jsonBody, /description/);
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `node --test n8n/workflows/research-workflow.test.mjs`
Expected: PASS, 31 tests total, 0 failures

- [ ] **Step 3: Commit**

```bash
git add n8n/workflows/research-workflow.test.mjs
git commit -m "$(cat <<'EOF'
Test the Caption Ready fan-out and YouTube metadata builder

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Config placeholders and README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- None (documentation/config only).

- [ ] **Step 1: Add the four new vars to `.env.example`**

Append to the end of `.env.example`:

```
YOUTUBE_CLIENT_ID=replace-with-google-oauth-client-id
YOUTUBE_CLIENT_SECRET=replace-with-google-oauth-client-secret
YOUTUBE_REFRESH_TOKEN=replace-with-youtube-channel-refresh-token
YOUTUBE_PRIVACY_STATUS=public
```

- [ ] **Step 2: Add a paragraph to `README.md`**

Find the sentence ending `...Configure INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID, INSTAGRAM_GRAPH_API_VERSION, and PUBLIC_MEDIA_BASE_URL in .env.prod.` (the last sentence of the README). Append this new paragraph directly after it:

```
A shared `Caption Ready` junction node is what the Instagram and YouTube branches both fan out from, so adding another platform later means adding one more branch off that node — nothing upstream changes. On that same branch, `Build YouTube Metadata` derives a title from the tool name and hook (truncated to YouTube's 100-character limit) and reuses the Instagram caption and hashtags as the description, appending `#Shorts` if it isn't already there — no extra Claude call. `Publish to YouTube` then calls the renderer's `/v1/publish/youtube`, which refreshes an OAuth access token, opens a resumable upload session with the YouTube Data API v3, and uploads the rendered file directly from the renderer's local `/output` volume — no public URL needed, unlike Instagram. Any failure in that chain — a bad refresh token, a failed session, or a failed upload — fails the run visibly, the same required behavior as Instagram. Configure `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, and optionally `YOUTUBE_PRIVACY_STATUS` (defaults to `public`) in `.env.prod`.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "$(cat <<'EOF'
Document YouTube Shorts publishing config and behavior

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Get OAuth credentials, deploy, and go live

**Files:** none (operational task — Google Cloud Console, SSH, Docker, n8n UI on the target server).

**Interfaces:** none — this task consumes everything built in Tasks 1-5 and makes it live.

- [ ] **Step 1: Create the Google Cloud OAuth client**

In Google Cloud Console: create (or reuse) a project, enable the **YouTube Data API v3** (APIs & Services → Library), then configure the OAuth consent screen (Testing mode is fine for a single channel — add the target channel's Google account as a test user under Audience), then create an OAuth 2.0 Client ID of type **Desktop app** (APIs & Services → Credentials). This gives `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`. **This step needs the user's own Google Cloud Console login — cannot be done from here.**

- [ ] **Step 2: Run the one-time authorization to mint a refresh token**

With `YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET` in hand, open this URL in a browser signed in as the target channel (replace `<CLIENT_ID>`):

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=https://www.googleapis.com/auth/youtube.upload&access_type=offline&prompt=consent
```

Approve the consent screen, copy the `code` it displays, then exchange it for tokens:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d client_id=<CLIENT_ID> \
  -d client_secret=<CLIENT_SECRET> \
  -d code=<CODE_FROM_BROWSER> \
  -d grant_type=authorization_code \
  -d redirect_uri=urn:ietf:wg:oauth:2.0:oob
```

The response's `refresh_token` field is `YOUTUBE_REFRESH_TOKEN` — it does not expire under normal use (only if revoked, unused for 6 months, or the OAuth consent screen stays in Testing mode past its 7-day test-user grant window, in which case redo this step). **This step needs the user's own Google login/consent in a browser — cannot be done from here.**

- [ ] **Step 3: Confirm SSH access and locate the deployment**

Run: `ssh mac-agent 'echo connected && hostname'`
Expected: prints `connected` and the remote hostname. Confirm this repo already exists there from the earlier Instagram deployment (e.g. `ssh mac-agent 'find / -maxdepth 4 -iname auto-reel-creation 2>/dev/null'`) — this determines whether Step 4 is a `git pull` or a fresh clone.

- [ ] **Step 4: Get the new code onto the server**

If the repo already exists there: `ssh mac-agent 'cd <path-to-repo> && git pull'`. If it doesn't: clone it there the same way it was set up for the Instagram deployment.

- [ ] **Step 5: Set the real config on the server**

Once Steps 1-2 have produced real values, SSH in and add them to that server's `.env.prod`:

```bash
ssh mac-agent 'cd <path-to-repo> && cat >> .env.prod << EOF
YOUTUBE_CLIENT_ID=<real client id>
YOUTUBE_CLIENT_SECRET=<real client secret>
YOUTUBE_REFRESH_TOKEN=<real refresh token>
YOUTUBE_PRIVACY_STATUS=public
EOF'
```

- [ ] **Step 6: Rebuild and restart the containers on the server**

```bash
ssh mac-agent 'cd <path-to-repo> && docker compose up --build -d'
```
Then verify: `ssh mac-agent 'curl -s http://localhost:3001/health'` → `{"ready":true,...}`.

- [ ] **Step 7: Apply the workflow changes to that server's n8n**

That server's n8n has its own database copy of the workflow, independent of the JSON file in git — same situation as every prior workflow change deployed there. Open that server's n8n and either re-import the whole updated `research-and-render-reel.json`, or apply the Task 3 rename + two new nodes + rewired connections through the UI directly (Cmd+K to find `Route Instagram Caption Result`, rename it to `Caption Ready`, add the two new nodes, drag the two connections). Confirm the workflow shows `Caption Ready` fanning out to both `Publish to Instagram` and `Build YouTube Metadata` → `Publish to YouTube`, then Publish.

- [ ] **Step 8: End-to-end verification**

Trigger the workflow and confirm: the execution reaches both `Publish to Instagram` and `Publish to YouTube`, the YouTube response contains a `videoId` and `url`, and the reel actually appears on the YouTube channel as a Short with the derived title and description.
