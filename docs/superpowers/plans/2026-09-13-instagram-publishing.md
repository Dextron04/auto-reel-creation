# Instagram Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a reel finishes rendering, automatically write an Instagram caption + hashtags with Claude (falling back to the existing SEO brief if that call fails) and publish the reel to Instagram as a Reel — no human approval step.

**Architecture:** Three new n8n nodes appended to the existing `Research and Render Local AI Reel` workflow build the caption and call a new renderer endpoint. That endpoint (`renderer/src/publish-instagram.mjs`, routed in `server.mjs`) owns the Instagram Graph API's create-container → poll → publish → permalink flow. The Instagram access token never leaves the renderer container. A new `/output` static route on the renderer, exposed through the user's existing Cloudflare Tunnel pattern, lets Instagram's servers fetch the rendered video by URL.

**Tech Stack:** Node.js 22 (global `fetch`, no new npm dependency), Express (existing), n8n Code/HTTP Request nodes, `node:test`.

## Global Constraints

- No human approval gate — publishing is fully automatic, overriding the project's previously-stated "human review required" policy, per explicit user decision.
- No community n8n nodes for Instagram — all Graph API logic is our own code, in the renderer, so the long-lived access token never runs through third-party code.
- No retries anywhere in the publish flow — any failure (bad token, container error, poll timeout, publish rejection) throws and the n8n execution shows Error, matching how every other stage of this pipeline already behaves.
- Target format is Instagram **Reels** (`media_type: 'REELS'`), not a feed video or image post.
- New env vars, read only inside the renderer container: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`, `INSTAGRAM_GRAPH_API_VERSION` (default `v21.0` if unset), `PUBLIC_MEDIA_BASE_URL`.
- Deployment target is the user's own server, reachable via the SSH alias `mac-agent` — not just this local Docker Desktop setup. The last task in this plan deploys there.

---

### Task 1: Renderer — Instagram Graph API module

**Files:**
- Create: `renderer/src/publish-instagram.mjs`
- Test: `renderer/src/publish-instagram.test.mjs`

**Interfaces:**
- Produces: `buildVideoUrl(outputLocation, baseUrl?)`, `createContainer({videoUrl, caption, accessToken, businessAccountId}, fetchImpl?)`, `pollUntilFinished({creationId, accessToken}, fetchImpl?, opts?)`, `publishContainer({creationId, accessToken, businessAccountId}, fetchImpl?)`, `getPermalink({mediaId, accessToken}, fetchImpl?)`, `publishToInstagram({outputLocation, caption}, fetchImpl?)` — the last is what Task 2's route calls. All return Promises; all throw `Error` with a specific message on failure (see step 3's code for exact messages).

- [ ] **Step 1: Write the failing tests**

Create `renderer/src/publish-instagram.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVideoUrl, createContainer, pollUntilFinished, publishContainer, getPermalink, publishToInstagram} from './publish-instagram.mjs';

const fakeResponse = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body});

test('buildVideoUrl joins the public base url and the output filename', () => {
  assert.equal(buildVideoUrl('/output/reel-123.mp4', 'https://media.example.com'), 'https://media.example.com/output/reel-123.mp4');
  assert.equal(buildVideoUrl('/output/reel-123.mp4', 'https://media.example.com/'), 'https://media.example.com/output/reel-123.mp4');
});
test('buildVideoUrl throws when no base url is configured', () => {
  assert.throws(() => buildVideoUrl('/output/reel-123.mp4', undefined), /PUBLIC_MEDIA_BASE_URL/);
});

test('createContainer returns the creation id from a successful response', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({url: String(url), init}); return fakeResponse(200, {id: 'creation-1'}); };
  const id = await createContainer({videoUrl: 'https://media.example.com/output/a.mp4', caption: 'hi', accessToken: 'tok', businessAccountId: 'biz-1'}, fetchImpl);
  assert.equal(id, 'creation-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/biz-1\/media$/);
  assert.equal(calls[0].init.method, 'POST');
});
test('createContainer throws on a non-2xx Graph API response', async () => {
  const fetchImpl = async () => fakeResponse(400, {error: {message: 'bad token'}});
  await assert.rejects(() => createContainer({videoUrl: 'x', caption: 'x', accessToken: 'x', businessAccountId: 'x'}, fetchImpl), /INSTAGRAM_API_ERROR:400/);
});
test('createContainer throws when the response has no id', async () => {
  const fetchImpl = async () => fakeResponse(200, {});
  await assert.rejects(() => createContainer({videoUrl: 'x', caption: 'x', accessToken: 'x', businessAccountId: 'x'}, fetchImpl), /INSTAGRAM_CONTAINER_NO_ID/);
});

test('pollUntilFinished resolves as soon as status is FINISHED', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'FINISHED'});
  await pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => { throw new Error('should not sleep'); }});
});
test('pollUntilFinished retries while IN_PROGRESS then resolves on FINISHED', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeResponse(200, {status_code: calls < 3 ? 'IN_PROGRESS' : 'FINISHED'}); };
  let slept = 0;
  await pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => { slept += 1; }});
  assert.equal(calls, 3);
  assert.equal(slept, 2);
});
test('pollUntilFinished throws on ERROR status', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'ERROR'});
  await assert.rejects(() => pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => {}}), /INSTAGRAM_CONTAINER_ERROR:ERROR/);
});
test('pollUntilFinished throws on EXPIRED status', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'EXPIRED'});
  await assert.rejects(() => pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => {}}), /INSTAGRAM_CONTAINER_ERROR:EXPIRED/);
});
test('pollUntilFinished throws INSTAGRAM_POLL_TIMEOUT when the budget runs out', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'IN_PROGRESS'});
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(
      () => pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {budgetMs: 100, intervalMs: 10, sleep: async () => { now += 20; }}),
      /INSTAGRAM_POLL_TIMEOUT/
    );
  } finally { Date.now = realNow; }
});

test('publishContainer returns the published media id', async () => {
  const fetchImpl = async () => fakeResponse(200, {id: 'media-1'});
  const id = await publishContainer({creationId: 'c1', accessToken: 'tok', businessAccountId: 'biz-1'}, fetchImpl);
  assert.equal(id, 'media-1');
});
test('publishContainer throws when the response has no id', async () => {
  const fetchImpl = async () => fakeResponse(200, {});
  await assert.rejects(() => publishContainer({creationId: 'c1', accessToken: 'tok', businessAccountId: 'biz-1'}, fetchImpl), /INSTAGRAM_PUBLISH_NO_ID/);
});

test('getPermalink returns the permalink', async () => {
  const fetchImpl = async () => fakeResponse(200, {permalink: 'https://instagram.com/reel/abc'});
  const permalink = await getPermalink({mediaId: 'media-1', accessToken: 'tok'}, fetchImpl);
  assert.equal(permalink, 'https://instagram.com/reel/abc');
});
test('getPermalink throws when the response has no permalink', async () => {
  const fetchImpl = async () => fakeResponse(200, {});
  await assert.rejects(() => getPermalink({mediaId: 'media-1', accessToken: 'tok'}, fetchImpl), /INSTAGRAM_PERMALINK_MISSING/);
});

test('publishToInstagram runs the full create/poll/publish/permalink chain', async () => {
  process.env.INSTAGRAM_ACCESS_TOKEN = 'tok';
  process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = 'biz-1';
  process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com';
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/biz-1/media_publish')) return fakeResponse(200, {id: 'media-1'});
    if (String(url).includes('/biz-1/media')) return fakeResponse(200, {id: 'creation-1'});
    if (String(url).includes('/creation-1')) return fakeResponse(200, {status_code: 'FINISHED'});
    if (String(url).includes('/media-1')) return fakeResponse(200, {permalink: 'https://instagram.com/reel/abc'});
    throw new Error(`unexpected url: ${url}`);
  };
  const result = await publishToInstagram({outputLocation: '/output/reel-1.mp4', caption: 'hi'}, fetchImpl);
  assert.deepEqual(result, {mediaId: 'media-1', permalink: 'https://instagram.com/reel/abc'});
  assert.equal(urls.length, 4);
});
test('publishToInstagram throws INSTAGRAM_NOT_CONFIGURED when env vars are missing', async () => {
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  await assert.rejects(() => publishToInstagram({outputLocation: '/output/reel-1.mp4', caption: 'hi'}, async () => fakeResponse(200, {})), /INSTAGRAM_NOT_CONFIGURED/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd renderer && node --test src/publish-instagram.test.mjs`
Expected: FAIL — `Cannot find module './publish-instagram.mjs'`

- [ ] **Step 3: Write the implementation**

Create `renderer/src/publish-instagram.mjs`:

```js
import path from 'node:path';

const GRAPH_VERSION = () => process.env.INSTAGRAM_GRAPH_API_VERSION || 'v21.0';
const graphBase = () => `https://graph.facebook.com/${GRAPH_VERSION()}`;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_BUDGET_MS = 150000;

export function buildVideoUrl(outputLocation, baseUrl = process.env.PUBLIC_MEDIA_BASE_URL) {
  if (!baseUrl) throw new Error('PUBLIC_MEDIA_BASE_URL not configured');
  return `${baseUrl.replace(/\/$/, '')}/output/${path.basename(outputLocation)}`;
}

async function graphRequest(fetchImpl, method, urlPath, params) {
  const url = new URL(`${graphBase()}${urlPath}`);
  const body = new URLSearchParams(params);
  if (method === 'GET') { for (const [key, value] of body) url.searchParams.set(key, value); }
  const response = await fetchImpl(url, method === 'GET' ? {method} : {method, body});
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(`INSTAGRAM_API_ERROR:${response.status}:${json.error?.message || 'unknown'}`);
  return json;
}

export async function createContainer({videoUrl, caption, accessToken, businessAccountId}, fetchImpl = fetch) {
  const json = await graphRequest(fetchImpl, 'POST', `/${businessAccountId}/media`, {media_type: 'REELS', video_url: videoUrl, caption, access_token: accessToken});
  if (!json.id) throw new Error('INSTAGRAM_CONTAINER_NO_ID');
  return json.id;
}

export async function pollUntilFinished({creationId, accessToken}, fetchImpl = fetch, {intervalMs = DEFAULT_POLL_INTERVAL_MS, budgetMs = DEFAULT_POLL_BUDGET_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))} = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const json = await graphRequest(fetchImpl, 'GET', `/${creationId}`, {fields: 'status_code', access_token: accessToken});
    if (json.status_code === 'FINISHED') return;
    if (json.status_code === 'ERROR' || json.status_code === 'EXPIRED') throw new Error(`INSTAGRAM_CONTAINER_ERROR:${json.status_code}`);
    if (Date.now() >= deadline) throw new Error('INSTAGRAM_POLL_TIMEOUT');
    await sleep(intervalMs);
  }
}

export async function publishContainer({creationId, accessToken, businessAccountId}, fetchImpl = fetch) {
  const json = await graphRequest(fetchImpl, 'POST', `/${businessAccountId}/media_publish`, {creation_id: creationId, access_token: accessToken});
  if (!json.id) throw new Error('INSTAGRAM_PUBLISH_NO_ID');
  return json.id;
}

export async function getPermalink({mediaId, accessToken}, fetchImpl = fetch) {
  const json = await graphRequest(fetchImpl, 'GET', `/${mediaId}`, {fields: 'permalink', access_token: accessToken});
  if (!json.permalink) throw new Error('INSTAGRAM_PERMALINK_MISSING');
  return json.permalink;
}

export async function publishToInstagram({outputLocation, caption}, fetchImpl = fetch) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !businessAccountId) throw new Error('INSTAGRAM_NOT_CONFIGURED');
  const videoUrl = buildVideoUrl(outputLocation);
  const creationId = await createContainer({videoUrl, caption, accessToken, businessAccountId}, fetchImpl);
  await pollUntilFinished({creationId, accessToken}, fetchImpl);
  const mediaId = await publishContainer({creationId, accessToken, businessAccountId}, fetchImpl);
  const permalink = await getPermalink({mediaId, accessToken}, fetchImpl);
  return {mediaId, permalink};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd renderer && node --test src/publish-instagram.test.mjs`
Expected: PASS, 15 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add renderer/src/publish-instagram.mjs renderer/src/publish-instagram.test.mjs
git commit -m "$(cat <<'EOF'
Add Instagram Graph API publish module

Create-container / poll-until-finished / publish / permalink chain as
small testable functions with an injectable fetch, matching the
getPublic() pattern already used in asset-discovery.mjs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Renderer — wire the endpoint and static route

**Files:**
- Modify: `renderer/src/server.mjs`

**Interfaces:**
- Consumes: `publishToInstagram({outputLocation, caption})` from Task 1 (`renderer/src/publish-instagram.mjs`).
- Produces: `POST /v1/publish/instagram` — request body `{outputLocation, caption}`, success response `{mediaId, permalink}` (HTTP 200), failure response `{error: string}` (HTTP 400). Static route `GET /output/<filename>`.

- [ ] **Step 1: Modify `server.mjs`**

Current content (`renderer/src/server.mjs`):

```js
import express from 'express';
import {renderReel} from './render.mjs';
import {discoverVisuals} from './asset-discovery.mjs';

const app = express();
app.use(express.json({limit: '256kb'}));
app.use('/media', express.static(process.env.MEDIA_ROOT ?? '/media', {dotfiles: 'deny', fallthrough: false}));
app.get('/health', (_req, res) => res.json({ready: true, renderer: 'remotion', canvas: '1080x1920'}));
app.post('/v1/visuals', async (req, res) => {
  try {res.json(await discoverVisuals(req.body));}
  catch (error) {res.status(400).json({error:error.message});}
});
app.post('/v1/render', async (req, res) => {
  try { res.status(202).json(await renderReel(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.listen(process.env.PORT ?? 3001, '0.0.0.0', () => console.log('renderer listening on 3001'));
```

Replace it with:

```js
import express from 'express';
import {renderReel} from './render.mjs';
import {discoverVisuals} from './asset-discovery.mjs';
import {publishToInstagram} from './publish-instagram.mjs';

const app = express();
app.use(express.json({limit: '256kb'}));
app.use('/media', express.static(process.env.MEDIA_ROOT ?? '/media', {dotfiles: 'deny', fallthrough: false}));
app.use('/output', express.static(process.env.OUTPUT_ROOT ?? '/output', {dotfiles: 'deny', fallthrough: false}));
app.get('/health', (_req, res) => res.json({ready: true, renderer: 'remotion', canvas: '1080x1920'}));
app.post('/v1/visuals', async (req, res) => {
  try {res.json(await discoverVisuals(req.body));}
  catch (error) {res.status(400).json({error:error.message});}
});
app.post('/v1/render', async (req, res) => {
  try { res.status(202).json(await renderReel(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/v1/publish/instagram', async (req, res) => {
  try { res.json(await publishToInstagram(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.listen(process.env.PORT ?? 3001, '0.0.0.0', () => console.log('renderer listening on 3001'));
```

- [ ] **Step 2: Run the full renderer test suite to confirm nothing broke**

Run: `cd renderer && npm test`
Expected: PASS, all existing tests plus the 15 from Task 1 still passing

- [ ] **Step 3: Commit**

```bash
git add renderer/src/server.mjs
git commit -m "$(cat <<'EOF'
Wire /v1/publish/instagram route and /output static serving

/output mirrors the existing /media static route so a Cloudflare
Tunnel can expose finished reels for Instagram to fetch by URL.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: n8n workflow — add the caption and publish nodes

**Files:**
- Modify: `n8n/workflows/research-and-render-reel.json`

**Interfaces:**
- Consumes: the render response's `outputLocation` field (from `Render 9:16 Reel with Subtitles`, itself `renderer/src/render-report.mjs`'s `createRenderReport()` output — unchanged by this plan); `research.recommended_topic` and `dialogue` fields already present on every item flowing through `Build Dialogue Audio and Subtitle Render Job` (unchanged upstream nodes).
- Produces: node ids `instagram-caption-prompt`, `instagram-caption-claude`, `route-instagram-caption`, `instagram-publish`. `route-instagram-caption`'s output shape: `{caption: string, captionSource: 'claude' | 'seo_fallback', outputLocation: string}`.

- [ ] **Step 1: Add the four new nodes to the `nodes` array**

Open `n8n/workflows/research-and-render-reel.json`. Find the node with `"id": "render-prep"`-adjacent entry `"name": "Render 9:16 Reel with Subtitles"` (an `n8n-nodes-base.httpRequest` node, `position: [3120, 0]`). Immediately after its closing `}` in the `nodes` array (before the array's closing `]` if it's the last node, otherwise before the next node's `{`), insert these four node objects:

```json
    {
      "parameters": {
        "jsCode": "const context = $items('Build Dialogue Audio and Subtitle Render Job')[0]?.json ?? {};\nconst topic = context.research?.recommended_topic ?? {};\nconst seoBrief = topic.seo_brief ?? {};\nconst dialogueLines = (context.dialogue || []).map((turn) => `${turn.speaker}: ${turn.text}`).join('\\n');\nconst prompt = `Write an Instagram Reel caption for a short animated dialogue video between Peter and Stewie about ${String(topic.tool_name ?? topic.topic ?? 'an AI developer tool')}.\\n\\nHook: ${topic.hook ?? ''}\\nOne-line value: ${topic.one_line_value ?? ''}\\n\\nDialogue:\\n${dialogueLines}\\n\\nExisting SEO keywords: ${(seoBrief.related_keywords || []).join(', ')}\\nExisting hashtag ideas: ${(seoBrief.hashtags || []).join(' ')}\\n\\nWrite a short, punchy caption (1-3 sentences, no hashtags inline) that hooks a developer scrolling Instagram, then 5-8 relevant hashtags. Reuse or refine the existing hashtag ideas above rather than inventing unrelated ones. No emojis unless they add real value. No stage directions.\\n\\nReturn ONLY JSON: {\"caption\":\"\",\"hashtags\":[\"#Tag1\",\"#Tag2\"]}`;\nreturn [{ json: { prompt, outputLocation: $json.outputLocation, seo_brief: seoBrief } }];"
      },
      "id": "instagram-caption-prompt",
      "name": "Build Instagram Caption Prompt",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3360, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {"name": "x-api-key", "value": "={{$env.ANTHROPIC_API_KEY}}"},
            {"name": "anthropic-version", "value": "={{$env.ANTHROPIC_VERSION || '2023-06-01'}}"},
            {"name": "Content-Type", "value": "application/json"}
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { model: $env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: $json.prompt }] } }}",
        "options": {
          "response": {"response": {"fullResponse": true, "responseFormat": "json"}},
          "timeout": 60000,
          "neverError": true
        }
      },
      "id": "instagram-caption-claude",
      "name": "Write Instagram Caption with Claude",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [3600, 0]
    },
    {
      "parameters": {
        "jsCode": "const promptItem = $items('Build Instagram Caption Prompt')[0]?.json ?? {};\nconst statusCode = Number($json.statusCode ?? 200);\nconst body = $json.body ?? $json;\nconst text = Array.isArray(body?.content) ? body.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\\n').trim() : '';\nlet caption; let captionSource = 'seo_fallback';\nif (statusCode >= 200 && statusCode < 300 && text) {\n  const fenced = text.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);\n  const candidate = String(fenced?.[1] ?? text).trim();\n  try {\n    const parsed = JSON.parse(candidate);\n    const parsedCaption = String(parsed.caption ?? '').trim();\n    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.map((tag) => String(tag).trim()).filter(Boolean) : [];\n    if (parsedCaption && hashtags.length) { caption = `${parsedCaption}\\n\\n${hashtags.join(' ')}`; captionSource = 'claude'; }\n  } catch {}\n}\nif (!caption) {\n  const seoBrief = promptItem.seo_brief ?? {};\n  const description = String(seoBrief.description ?? '').trim();\n  const hashtags = Array.isArray(seoBrief.hashtags) ? seoBrief.hashtags : [];\n  caption = [description, hashtags.join(' ')].filter(Boolean).join('\\n\\n');\n}\nif (!caption) throw new Error('INSTAGRAM_CAPTION_UNAVAILABLE');\nreturn [{ json: { caption, captionSource, outputLocation: promptItem.outputLocation } }];"
      },
      "id": "route-instagram-caption",
      "name": "Route Instagram Caption Result",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [3840, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://renderer:3001/v1/publish/instagram",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [{"name": "Content-Type", "value": "application/json"}]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { outputLocation: $json.outputLocation, caption: $json.caption } }}",
        "options": {
          "response": {"response": {"responseFormat": "json"}},
          "timeout": 180000
        }
      },
      "id": "instagram-publish",
      "name": "Publish to Instagram",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [4080, 0]
    }
```

- [ ] **Step 2: Wire the connections**

In the `connections` object, find `"Render 9:16 Reel with Subtitles"`. It currently has no entry (it's the terminal node). Add:

```json
    "Render 9:16 Reel with Subtitles": {
      "main": [[{"node": "Build Instagram Caption Prompt", "type": "main", "index": 0}]]
    },
    "Build Instagram Caption Prompt": {
      "main": [[{"node": "Write Instagram Caption with Claude", "type": "main", "index": 0}]]
    },
    "Write Instagram Caption with Claude": {
      "main": [[{"node": "Route Instagram Caption Result", "type": "main", "index": 0}]]
    },
    "Route Instagram Caption Result": {
      "main": [[{"node": "Publish to Instagram", "type": "main", "index": 0}]]
    }
```

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('n8n/workflows/research-and-render-reel.json')); print('valid JSON')"`
Expected: `valid JSON`

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/research-and-render-reel.json
git commit -m "$(cat <<'EOF'
Append Instagram caption generation and publish steps to the workflow

Render -> caption prompt -> Claude -> fallback-aware router -> publish.
Falls back to the existing seo_brief caption/hashtags if the Claude
call fails; the publish step has no fallback and fails the execution
loudly, matching the rest of the pipeline.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: n8n workflow — tests for the new nodes

**Files:**
- Modify: `n8n/workflows/research-workflow.test.mjs`

**Interfaces:**
- Consumes: `nodeById` map (already defined at the top of the test file), node ids `instagram-caption-prompt` and `route-instagram-caption` from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to the end of `n8n/workflows/research-workflow.test.mjs`:

```js
test('Instagram caption prompt includes the tool context, dialogue, and JSON instruction', () => {
  const promptNode = nodeById.get('instagram-caption-prompt');
  assert.ok(promptNode, 'missing instagram-caption-prompt node');
  const context = {json: {
    research: {recommended_topic: {tool_name: 'Agent Kit', hook: 'Stop writing glue code', one_line_value: 'One interface for every coding agent', seo_brief: {related_keywords: ['agent kit'], hashtags: ['#AgentKit', '#DevTools']}}},
    dialogue: [{speaker: 'peter', text: 'Meet Agent Kit.'}, {speaker: 'stewie', text: 'Why do I care?'}],
  }};
  const items = () => [context];
  const result = new Function('$json', '$items', promptNode.parameters.jsCode)({outputLocation: '/output/reel-1.mp4'}, items);
  assert.equal(result.length, 1);
  assert.match(result[0].json.prompt, /Agent Kit/);
  assert.match(result[0].json.prompt, /Meet Agent Kit\./);
  assert.match(result[0].json.prompt, /Return ONLY JSON/);
  assert.equal(result[0].json.outputLocation, '/output/reel-1.mp4');
  assert.deepEqual(result[0].json.seo_brief.hashtags, ['#AgentKit', '#DevTools']);
});

test('Instagram caption router combines Claude output or falls back to the SEO brief', () => {
  const routeNode = nodeById.get('route-instagram-caption');
  assert.ok(routeNode, 'missing route-instagram-caption node');
  const promptItem = {json: {outputLocation: '/output/reel-1.mp4', seo_brief: {description: 'Agent Kit gives every coding agent one interface.', hashtags: ['#AgentKit', '#DevTools', '#Coding']}}};
  const items = () => [promptItem];
  const run = (json) => new Function('$json', '$items', routeNode.parameters.jsCode)(json, items);

  const success = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({caption: 'Stop writing glue code for every coding agent.', hashtags: ['#AgentKit', '#DevTools']})}]}});
  assert.equal(success[0].json.captionSource, 'claude');
  assert.match(success[0].json.caption, /Stop writing glue code/);
  assert.match(success[0].json.caption, /#AgentKit #DevTools/);
  assert.equal(success[0].json.outputLocation, '/output/reel-1.mp4');

  const httpError = run({statusCode: 500, body: {error: {type: 'server_error'}}});
  assert.equal(httpError[0].json.captionSource, 'seo_fallback');
  assert.match(httpError[0].json.caption, /Agent Kit gives every coding agent one interface\./);
  assert.match(httpError[0].json.caption, /#AgentKit #DevTools #Coding/);

  const badJson = run({statusCode: 200, body: {content: [{type: 'text', text: 'Sure, here you go without json'}]}});
  assert.equal(badJson[0].json.captionSource, 'seo_fallback');
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `node --test n8n/workflows/research-workflow.test.mjs`
Expected: PASS, 17 tests total, 0 failures

- [ ] **Step 3: Commit**

```bash
git add n8n/workflows/research-workflow.test.mjs
git commit -m "$(cat <<'EOF'
Test Instagram caption prompt building and fallback routing

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
INSTAGRAM_ACCESS_TOKEN=replace-with-instagram-long-lived-access-token
INSTAGRAM_BUSINESS_ACCOUNT_ID=replace-with-instagram-business-account-id
INSTAGRAM_GRAPH_API_VERSION=v21.0
PUBLIC_MEDIA_BASE_URL=https://replace-with-your-media-tunnel-hostname
```

- [ ] **Step 2: Add a paragraph to `README.md`**

Find the paragraph ending "...Human review remains required before publication, and platform publishing is not included." (the last paragraph of the "Research workflow" section). Replace that final sentence with:

```
Human review is no longer required before publication for Instagram: after render, `Write Instagram Caption with Claude` drafts a short caption and 5-8 hashtags from the tool's hook, one-line value, the dialogue, and the existing SEO brief; if that call fails or returns unusable JSON, the caption falls back to the SEO brief's own description and hashtags. `Publish to Instagram` then calls the renderer's `/v1/publish/instagram`, which creates a Reels media container from the video (served publicly at `PUBLIC_MEDIA_BASE_URL` via the same Cloudflare Tunnel pattern used elsewhere), polls until Instagram finishes processing it, publishes it, and returns the permalink. Any failure in that chain — including a container error or a poll timeout — fails the run visibly rather than retrying or posting anything partial. Configure `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`, `INSTAGRAM_GRAPH_API_VERSION`, and `PUBLIC_MEDIA_BASE_URL` in `.env.prod`.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "$(cat <<'EOF'
Document Instagram publishing config and behavior

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Deploy to the server and go live

**Files:** none (operational task — SSH, Docker, n8n UI, Cloudflare dashboard on the target server).

**Interfaces:** none — this task consumes everything built in Tasks 1-5 and makes it live.

- [ ] **Step 1: Confirm SSH access and locate the deployment**

Run: `ssh mac-agent 'echo connected && hostname'`
Expected: prints `connected` and the remote hostname. Then check whether this repo already exists there (e.g. `ssh mac-agent 'find / -maxdepth 4 -iname auto-reel-creation 2>/dev/null'` or ask the user directly if unsure) — this determines whether Step 2 is a `git pull` or a fresh clone.

- [ ] **Step 2: Get the new code onto the server**

If the repo already exists there: `ssh mac-agent 'cd <path-to-repo> && git pull'`.
If it doesn't: clone it there the same way it exists locally (exact remote/path to be confirmed with the user at execution time — this repo's git remote, if any, or an `rsync` of the working tree).

- [ ] **Step 3: Confirm the four Meta prerequisites are ready**

Per the spec's setup section, before this can work end-to-end the user needs: a Meta Developer App (Business type) with the Instagram Graph API product added, the target IG account added as a tester, a long-lived access token with `instagram_content_publish`, and the IG Business Account ID. **Do not proceed to Step 4 until the user confirms these exist and provides the token + account ID** — these cannot be generated or guessed from here; they come from Meta's own dashboards.

- [ ] **Step 4: Set the real config on the server**

Once the user has provided the real values, SSH in and add them to that server's `.env.prod` (create the file from `.env.example` first if it doesn't exist yet there):

```bash
ssh mac-agent 'cd <path-to-repo> && cat >> .env.prod << EOF
INSTAGRAM_ACCESS_TOKEN=<real token>
INSTAGRAM_BUSINESS_ACCOUNT_ID=<real id>
INSTAGRAM_GRAPH_API_VERSION=v21.0
PUBLIC_MEDIA_BASE_URL=https://<the tunnel hostname chosen in Step 5>
EOF'
```

- [ ] **Step 5: Add the Cloudflare Tunnel route**

Add a public hostname (e.g. `media.dextron04.in`) routed to the renderer container's port 3001, restricted to the `/output` path if the tunnel config supports path-scoped ingress rules. Exact steps depend on how the existing `home.dextron04.in` / `voice.dextron04.in` tunnels are configured on that server (a `cloudflared` config file, or the Cloudflare Zero Trust dashboard) — inspect that config on the server first (e.g. `ssh mac-agent 'cat ~/.cloudflared/config.yml'` or equivalent) and add a matching ingress entry, then reload `cloudflared`.

- [ ] **Step 6: Rebuild and restart the containers on the server**

```bash
ssh mac-agent 'cd <path-to-repo> && docker compose up --build -d'
```
Then verify: `ssh mac-agent 'curl -s http://localhost:3001/health'` → `{"ready":true,...}`.

- [ ] **Step 7: Apply the workflow changes to that server's n8n**

That server's n8n has its own database copy of the workflow, independent of the JSON file in git — the same situation encountered earlier in this project when the local Docker n8n needed its `Route Claude Dialogue Result` node patched directly through the UI. Open that server's n8n (URL depends on how it's exposed — check the existing `home.dextron04.in`-style tunnel setup, or `http://<server>:5678` if only reachable inside a private network), and either re-import the whole updated `research-and-render-reel.json`, or add the four new nodes through the UI the same way the earlier fixes were applied in this session (Cmd+K to find a node, click into its code, edit, Publish). Confirm the workflow shows the new nodes wired after `Render 9:16 Reel with Subtitles`, then Publish.

- [ ] **Step 8: End-to-end verification**

Trigger the workflow (or a manual test hitting the renderer directly with a small already-rendered file) and confirm: the execution reaches `Publish to Instagram`, the response contains a `permalink`, and the reel actually appears on the Instagram account as a Reel with the generated caption and hashtags.
