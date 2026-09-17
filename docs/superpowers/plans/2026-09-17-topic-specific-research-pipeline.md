# Topic-Specific Research Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace prompt-only topic separation with topic-aware source retrieval, fail-closed research validation, clean no-result outcomes, and two reusable Tips/Trend core workflows behind the ten existing topic entry points.

**Architecture:** The renderer owns an immutable five-topic registry, SearXNG-backed retrieval, relevance filtering, caching, research-package validation, and run records. n8n keeps ten operationally compatible wrappers but moves duplicated production logic into one Tips core and one Trend core; all model output must pass renderer validation and a topic-aware editorial judge before dialogue generation.

**Tech Stack:** Node.js ESM, Express, built-in `node:test`, n8n workflow JSON, SearXNG JSON API, Anthropic Messages API with existing local-Qwen fallback conventions, filesystem JSON caches under `/media`.

**Spec:** `docs/superpowers/specs/2026-09-17-topic-specific-research-pipeline-design.md`

## Global Constraints

- Preserve all ten existing workflow names, webhook paths, topic-history namespaces, audio paths, dashboard selectors, and round-robin roster entries.
- Topic slugs are exactly `agentic-ai`, `editor-ide`, `git-cli`, `databases-performance`, and `debugging-observability`.
- Formats are exactly `tips` and `trend`; a wrapper selects the format by choosing a core workflow, not by accepting arbitrary caller input.
- Research input is capped at 20 qualified sources.
- Retrieval performs at most one query expansion and research performs at most one validator-guided retry.
- Explicit topic exclusions override positive relevance signals.
- A normal evidence shortage is HTTP 200 with `status: "no_in_scope_research"`; infrastructure failures remain non-2xx.
- Off-topic, untraceable, or structurally invalid research cannot reach dialogue, rendering, topic history, or publishing.
- No new paid service or credential is introduced; use the existing SearXNG and model configuration.
- Implement with tests first and commit each independently reviewable task.

---

### Task 1: Immutable Topic Registry

**Files:**
- Create: `renderer/src/research-topic-registry.mjs`
- Create: `renderer/src/research-topic-registry.test.mjs`

**Interfaces:**
- Produces: `TOPIC_SLUGS`, `TOPIC_FORMATS`, `validateTopicRegistry(registry)`, and `getResearchTopic(slug)`.
- `getResearchTopic(slug)` returns a frozen object containing `slug`, `displayName`, `scope`, `includeTerms`, `excludeTerms`, `preferredDomains`, `tipsQueries`, `trendQueries`, `minimumQualifiedSources`, and `minimumPrimarySources`.

- [ ] **Step 1: Write failing registry tests**

Test all five exact slugs, uniqueness, frozen results, non-empty scope/query/domain arrays, legal integer thresholds, and `RESEARCH_TOPIC_UNKNOWN:<slug>` for unknown values. Assert representative routing data: Editor includes `code.visualstudio.com`; Git/CLI includes `git-scm.com`; Databases includes `postgresql.org`; Debugging includes `opentelemetry.io`; Agentic includes `model context protocol` in its vocabulary.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test renderer/src/research-topic-registry.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the registry and validation**

Use this public shape:

```js
export const TOPIC_SLUGS = Object.freeze([
  'agentic-ai', 'editor-ide', 'git-cli',
  'databases-performance', 'debugging-observability',
]);
export const TOPIC_FORMATS = Object.freeze(['tips', 'trend']);
export function validateTopicRegistry(registry) { /* throw RESEARCH_TOPIC_REGISTRY_INVALID:<reason> */ }
export function getResearchTopic(slug) { /* throw RESEARCH_TOPIC_UNKNOWN:<slug> */ }
```

Populate actionable query packs and official domains for every topic. Deep-freeze arrays and returned entries so workflow code cannot mutate policy at runtime.

- [ ] **Step 4: Run the focused test**

Run: `node --test renderer/src/research-topic-registry.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/research-topic-registry.mjs renderer/src/research-topic-registry.test.mjs
git commit -m "feat: add topic research registry"
```

### Task 2: Topic-Aware Retrieval, Scoring, and Cache

**Files:**
- Create: `renderer/src/research-cache.mjs`
- Create: `renderer/src/research-cache.test.mjs`
- Create: `renderer/src/research-sources.mjs`
- Create: `renderer/src/research-sources.test.mjs`

**Interfaces:**
- Consumes: `getResearchTopic(slug)` and `TOPIC_FORMATS` from Task 1.
- Produces: `canonicalizeResearchUrl(url)`, `buildResearchQueries(topic, format, expanded)`, `normalizeResearchResult(raw, context)`, `scoreResearchSource(source, topic, format, now)`, `filterResearchSources(sources, topic, format, options)`, and `retrieveResearchSources(options)`.
- `retrieveResearchSources({topicSlug, format, recentTopics = [], fetchImpl = fetch, searxngUrl = process.env.SEARXNG_URL, now = new Date(), mediaDir = process.env.MEDIA_ROOT ?? '/media', classifyBorderline})` returns the exact `ready` or `no_in_scope_research` contract in the spec.

- [ ] **Step 1: Write failing cache tests**

Cover `{topicSlug, format, UTC date}` keying, 12-hour freshness, expired entries, corrupt JSON recovery, atomic temp-file rename, and cache isolation by topic and format.

- [ ] **Step 2: Implement the cache**

Store cache files below `${mediaDir}/research-cache/`. Export `readResearchCache`, `writeResearchCache`, and `researchCachePath`; never expose authorization data in cached values.

- [ ] **Step 3: Write failing retrieval tests**

Use an injected fake SearXNG `fetchImpl`. Assert:

- Tips and Trend produce different queries.
- Preferred domains get an authority boost.
- Explicit exclusion terms reject a result even when include terms match.
- Mixed-topic fixtures retain only the requested topic.
- URL tracking parameters/fragments are removed and duplicates collapse.
- At most 20 sources are returned.
- One bounded expanded query pass occurs when the first pass is short.
- A borderline batch calls the injected `classifyBorderline` once and admits only `{in_scope:true}` rows above the confidence threshold.
- Too few sources return HTTP-layer-independent `status: 'no_in_scope_research'` rather than throwing.
- Missing SearXNG configuration and non-2xx search responses throw infrastructure errors.

- [ ] **Step 4: Implement retrieval and hybrid filtering**

Call SearXNG as:

```js
const url = new URL('/search', searxngUrl);
url.searchParams.set('q', query);
url.searchParams.set('format', 'json');
url.searchParams.set('categories', 'general');
```

Normalize only `http:`/`https:` results, cap each query at 10 results, cap raw candidates at 100, classify borderline rows in one batch, and retain the top 20 by `relevance_score`. Return diagnostics with `queryCount`, `rawCount`, `dedupedCount`, `qualifiedCount`, `primaryCount`, and `cacheHit`.

- [ ] **Step 5: Run focused tests**

Run: `node --test renderer/src/research-cache.test.mjs renderer/src/research-sources.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/research-cache.mjs renderer/src/research-cache.test.mjs renderer/src/research-sources.mjs renderer/src/research-sources.test.mjs
git commit -m "feat: retrieve topic-specific research sources"
```

### Task 3: Research Package Validator

**Files:**
- Create: `renderer/src/research-package-validator.mjs`
- Create: `renderer/src/research-package-validator.test.mjs`

**Interfaces:**
- Consumes: `getResearchTopic(slug)` from Task 1 and evidence records from Task 2.
- Produces: `validateResearchPackage({topicSlug, format, evidence, research, classifyCandidate})` returning `{valid, research?, diagnostics, failureCode?, reasons}`.

- [ ] **Step 1: Write adversarial failing tests**

Create mixed fixtures for all five topics. Assert rejection when:

- `recommended_topic` is not `candidates[0]`.
- AI SDK Harness is recommended for Editor/IDE.
- Git/CLI or Debugging receives generic AI news.
- A database tip has no specific action or concrete payoff.
- A claim cites a URL absent from the evidence set.
- No primary source supports the recommendation.
- Required Tips or Trend fields are absent.

Assert acceptance for one valid candidate per topic, URL canonicalization, and valid empty research mapping to `NO_IN_SCOPE_RESEARCH` rather than invalid JSON.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test renderer/src/research-package-validator.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement fail-closed validation**

The validator must never rewrite a candidate or manufacture citations. `classifyCandidate` is an injected batch callback for semantic ambiguity; deterministic exclusions and unknown evidence URLs reject before classification. Preserve the original research object only on `valid: true`.

- [ ] **Step 4: Run the focused test**

Run: `node --test renderer/src/research-package-validator.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/research-package-validator.mjs renderer/src/research-package-validator.test.mjs
git commit -m "feat: validate topic research packages"
```

### Task 4: Borderline Semantic Classifier and Research Records

**Files:**
- Create: `renderer/src/research-classifier.mjs`
- Create: `renderer/src/research-classifier.test.mjs`
- Create: `renderer/src/research-record.mjs`
- Create: `renderer/src/research-record.test.mjs`

**Interfaces:**
- Produces: `classifyResearchItems({topic, items, kind, fetchImpl, env})` and `writeResearchRecord({runId, record, mediaDir})`.
- Classifier result is an array matching input IDs: `{id, in_scope, confidence, reason}`.

- [ ] **Step 1: Write failing classifier tests**

Mock Anthropic success, fenced JSON, malformed response, HTTP failure, and local-Qwen fallback using the project’s existing environment names. Assert a single batch request, strict ID preservation, confidence clamping, and no prompt field capable of changing the registry scope.

- [ ] **Step 2: Implement the constrained classifier**

Use `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OLLAMA_CF_ACCESS_CLIENT_ID`, and `OLLAMA_CF_ACCESS_CLIENT_SECRET` consistently with existing n8n fallback policy. The prompt contains only the immutable scope plus item ID/title/summary; output schema contains only ID, boolean, confidence, and reason.

- [ ] **Step 3: Write and implement research-record tests**

Write atomically below `${mediaDir}/research-runs/<runId>.json`. Reject unsafe run IDs. Recursively redact keys matching `authorization`, `api[-_]?key`, `token`, `secret`, or `headers`. Preserve topic, format, diagnostics, URLs, decisions, and final outcome.

- [ ] **Step 4: Run focused tests**

Run: `node --test renderer/src/research-classifier.test.mjs renderer/src/research-record.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/research-classifier.mjs renderer/src/research-classifier.test.mjs renderer/src/research-record.mjs renderer/src/research-record.test.mjs
git commit -m "feat: classify and record research decisions"
```

### Task 5: Renderer Research APIs

**Files:**
- Modify: `renderer/src/server.mjs`
- Create: `renderer/src/research-api.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-4.
- Adds: `POST /v1/research/sources`, `POST /v1/research/validate`, and `POST /v1/research/record`.

- [ ] **Step 1: Refactor server construction for route testing**

Export `createApp(dependencies = {})` and call `app.listen(...)` only when `server.mjs` is the process entry module. Preserve every existing route unchanged.

- [ ] **Step 2: Write failing HTTP contract tests**

Start the Express app on an ephemeral port with injected retrieval, validator, classifier, and record writers. Assert:

- Unknown topic/format returns 400.
- `ready` and `no_in_scope_research` both return 200.
- Retrieval infrastructure errors return 502.
- Invalid research returns 422 with reasons.
- Valid research returns 200 and preserves the payload.
- Record writes return 200 with path/outcome.
- Request bodies remain under the existing 256 KB limit.

- [ ] **Step 3: Implement the routes**

Pass the semantic classifier only for borderline retrieval/candidate checks. Do not accept topic policy fields from requests. Map known validation errors to 400/422 and infrastructure failures to 502.

- [ ] **Step 4: Run renderer tests**

Run: `npm --prefix renderer test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/server.mjs renderer/src/research-api.test.mjs
git commit -m "feat: expose research safety APIs"
```

### Task 6: Immediate Safety Gates in Existing Topic Workers

**Files:**
- Modify: `n8n/workflows/topic-*-tips-reel.json`
- Modify: `n8n/workflows/topic-*-trend-reel.json`
- Modify: `n8n/workflows/topic-workflows.test.mjs`

**Interfaces:**
- Consumes: `/v1/research/validate` and `/v1/research/record` from Task 5.
- Produces: current ten workflows that fail closed before dialogue while full retrieval migration is in progress.

- [ ] **Step 1: Add failing workflow-structure tests**

For all ten files assert:

- `Validate Topic Research Package` follows normalization/history selection and precedes any dialogue node.
- Request body includes immutable file-specific `topicSlug`, fixed format, exact evidence from `Build Research Prompt`, and normalized research.
- Invalid/no-result routes cannot reach dialogue, visuals, render, history, or publishing.
- Both Tips and Trend include a topic-aware judge prompt containing their configured scope.
- A valid empty candidate package is routed to `Record Research Skip` rather than normalization failure.

- [ ] **Step 2: Run the workflow test and confirm failure**

Run: `node --test n8n/workflows/topic-workflows.test.mjs`

- [ ] **Step 3: Update all ten workflows mechanically**

Use a repository script or one deterministic transformation, not ten hand-edited variants. Add validation, bounded retry count, skip recording, and topic-aware judge wiring. Preserve names, webhooks, namespaces, audio paths, render/publish branches, and existing model fallback behavior.

- [ ] **Step 4: Run all workflow regression suites**

Run:

```bash
node --test n8n/workflows/research-workflow.test.mjs
node --test n8n/workflows/dev-tips-workflow.test.mjs
node --test n8n/workflows/topic-workflows.test.mjs
node --test n8n/workflows/topic-round-robin-orchestrator.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflows
git commit -m "feat: block off-topic research before production"
```

### Task 7: Replace Generic Feed Fan-In with Topic Retrieval

**Files:**
- Modify: `n8n/workflows/topic-*-tips-reel.json`
- Modify: `n8n/workflows/topic-*-trend-reel.json`
- Modify: `n8n/workflows/topic-workflows.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: `POST /v1/research/sources` from Task 5.
- Produces: all ten workers sourcing at most 20 topic-qualified evidence records.

- [ ] **Step 1: Replace the old feed assertion with failing retrieval assertions**

Assert each workflow calls `/v1/research/sources` with its immutable slug/format, routes `no_in_scope_research` to skip recording, feeds only returned `sources` into `Build Research Prompt`, and no longer connects the eleven generic RSS nodes to topic research.

- [ ] **Step 2: Update workflow definitions**

Add `Fetch Topic-Specific Research Sources` and `Research Sources Available?`. Remove or disconnect the generic eleven-feed fan-in and generic scorer from the production path. Preserve diagnostic source data through normalization and validator calls.

- [ ] **Step 3: Update README operational documentation**

Document topic-specific retrieval, clean skip outcomes, the 20-source cap, cache location, SearXNG dependency, validation gate, and research-run record location.

- [ ] **Step 4: Run renderer and workflow suites**

Run: `npm --prefix renderer test && node --test n8n/workflows/topic-workflows.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflows README.md
git commit -m "feat: use topic-specific research retrieval"
```

### Task 8: Consolidate into Tips and Trend Core Workflows

**Files:**
- Create: `n8n/workflows/topic-tips-core.json`
- Create: `n8n/workflows/topic-trend-core.json`
- Modify: ten `n8n/workflows/topic-*-reel.json` wrappers
- Create: `scripts/build-topic-workflows.mjs`
- Create: `scripts/build-topic-workflows.test.mjs`
- Modify: `n8n/workflows/topic-workflows.test.mjs`
- Modify: `scripts/deploy-server.sh`

**Interfaces:**
- Core input: `{topicSlug}`.
- Wrapper behavior: attach one immutable slug and invoke the fixed format core.
- Generator owns wrapper-to-slug/core mappings and preserves operational identifiers.

- [ ] **Step 1: Write failing generator and topology tests**

Assert ten exact wrappers, five per core, preservation of names/webhook paths/history/audio namespaces, unknown-slug rejection, no schedules in wrappers/cores, and one production implementation per format. Assert `scripts/build-topic-workflows.mjs --check` exits nonzero when generated JSON drifts.

- [ ] **Step 2: Extract representative format cores**

Use Agentic Tips and Agentic Trend as structural bases only after replacing hard-coded slug/name/path values with core input and registry lookups. The core must reject absent/unknown slugs before retrieval.

- [ ] **Step 3: Generate thin compatibility wrappers**

Each wrapper keeps its existing trigger and dashboard webhook, attaches its slug, invokes the correct core with `waitForSubWorkflow: true`, and returns the core outcome. The round-robin continues to invoke wrapper IDs unchanged.

- [ ] **Step 4: Make deployment verify generated files**

Run `node scripts/build-topic-workflows.mjs --check` before workflow regression tests in `scripts/deploy-server.sh`. Include both new core workflow JSON files in the existing sync loop.

- [ ] **Step 5: Run generation and full local suites**

Run:

```bash
node scripts/build-topic-workflows.mjs
node scripts/build-topic-workflows.mjs --check
npm --prefix renderer test
npm --prefix dashboard test
node --test n8n/workflows/*.test.mjs scripts/*.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add n8n/workflows scripts
git commit -m "refactor: consolidate topic research workflows"
```

### Task 9: Shadow-Mode Verification and Production Deployment

**Files:**
- Create: `scripts/verify-topic-research.mjs`
- Create: `scripts/verify-topic-research.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Script accepts renderer base URL and emits a per-topic/format JSON report without invoking dialogue, rendering, history writes, or publishing.
- Exit zero only when all ten combinations satisfy structural acceptance criteria; a clean no-result combination is reported, not failed.

- [ ] **Step 1: Write failing verifier tests**

Mock all ten responses and assert detection of off-topic candidates, unknown claim URLs, recommendation-order mismatch, missing primary evidence, excess source count, and accidental downstream invocation. Assert clean no-result reporting.

- [ ] **Step 2: Implement the shadow verifier**

For each registry slug and format, call source retrieval, stop cleanly on no-result, and validate a supplied fixture research package or research-only provider response. Never call dialogue, visuals, TTS, render, topic-history POST, Instagram, or YouTube endpoints.

- [ ] **Step 3: Run full local verification**

Run:

```bash
npm --prefix renderer test
npm --prefix dashboard test
node --test n8n/workflows/*.test.mjs scripts/*.test.mjs
node scripts/build-topic-workflows.mjs --check
```

Expected: PASS.

- [ ] **Step 4: Deploy to `mac-agent`**

Push the reviewed commits to the deployment branch, allow the existing deployment runner to rebuild renderer/dashboard and sync workflows, then verify `/health`, dashboard status, and the presence of both core workflows plus ten wrappers. Do not manually overwrite `.env.prod` or untracked server files.

- [ ] **Step 5: Run all ten combinations with publishing disabled**

Use the shadow verifier and live execution data. Confirm the spec’s acceptance thresholds: topic gate pass for every selection, source count at most 20, source URL provenance, primary evidence, clean skips, and no downstream nodes for skipped runs.

- [ ] **Step 6: Enable wrappers incrementally**

Canary in this order: Agentic pair, Editor/IDE pair, Git/CLI pair, Databases/Performance pair, Debugging/Observability pair. After each pair, inspect research-run records and n8n execution data before proceeding.

- [ ] **Step 7: Commit documentation and verifier**

```bash
git add scripts/verify-topic-research.mjs scripts/verify-topic-research.test.mjs README.md
git commit -m "test: verify topic research in shadow mode"
```

## Completion verification

- [ ] Run `git status --short` and confirm only intentionally untracked user files remain.
- [ ] Run the complete renderer, dashboard, workflow, and script test suites.
- [ ] Run `node scripts/build-topic-workflows.mjs --check`.
- [ ] Inspect the final diff for secrets, duplicated topic policy, stale generic-feed wiring, and missing skip branches.
- [ ] Confirm live `mac-agent` workflow inventory and at least one safe outcome for every topic/format combination before declaring production completion.
