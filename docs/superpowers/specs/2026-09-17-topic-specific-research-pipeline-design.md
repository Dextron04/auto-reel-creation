# Topic-Specific Research Pipeline Design

## Goal

Make every topic and format worker retrieve, select, and publish research that is demonstrably relevant to its configured editorial scope. A generic developer-news item must never become an Editor/IDE, Git/CLI, Databases/Performance, or Debugging/Observability reel merely because a language model ignored a prompt instruction.

The optimized system must also reduce duplicated n8n logic, reduce model input cost, treat a lack of qualified evidence as a normal outcome, and preserve the ten existing workflow names and dashboard entry points during migration.

## Current failure mode

All ten topic workers currently:

1. Fetch the same eleven general AI/developer-news feeds.
2. Apply the same generic trend scoring.
3. Pass up to 35-45 results to a topic-specific research prompt.
4. Trust the model to obey the topic boundary.

The topic boundary therefore exists only in prose. There is no topic-aware retrieval, deterministic pre-filter, post-research scope validation, or source-membership enforcement. The tips judge evaluates novelty and payoff but not topic membership, while trend workers have no equivalent pre-production topic judge.

The live audit demonstrated both possible failures:

- Editor/IDE Tips correctly returned no in-scope candidates because all 35 supplied sources were about agents, APIs, and cloud infrastructure. The normalizer treated that valid result as malformed JSON and failed the execution.
- Editor/IDE Trend accepted and published an AI SDK harness topic that belonged to the Agentic AI worker.

## Design principles

1. **Retrieval owns topic relevance.** The research prompt is a synthesis layer, not the first relevance filter.
2. **Publication fails closed.** No reel proceeds when topic membership, evidence provenance, or schema validity is uncertain.
3. **No evidence is not an error.** A topic can have no worthwhile material on a given run; that result should be recorded and the rotation should continue.
4. **Configuration is data.** Topic definitions, query templates, preferred sources, exclusions, and evidence thresholds live in one validated registry.
5. **Formats share retrieval infrastructure but not editorial policy.** Tips and Trends use different query packs, scoring rules, schemas, and judges.
6. **Preserve operational compatibility.** Existing workflow names, webhook paths, history namespaces, output paths, and dashboard selectors remain usable while the implementation is migrated.

## Architecture

### Components

#### 1. Canonical topic registry

Add `renderer/src/research-topic-registry.mjs` as the single runtime source of truth. Each entry contains:

```js
{
  slug: 'editor-ide',
  displayName: 'Editor & IDE Power Features',
  scope: 'code editor and IDE features ...',
  includeTerms: ['vscode', 'visual studio code', 'jetbrains', 'vim', 'neovim', ...],
  excludeTerms: ['agent harness', 'cloud deployment', ...],
  preferredDomains: ['code.visualstudio.com', 'blog.jetbrains.com', 'neovim.io', ...],
  tipsQueries: ['VS Code lesser known feature', 'JetBrains productivity shortcut', ...],
  trendQueries: ['VS Code release notes', 'JetBrains IDE new feature', ...],
  minimumQualifiedSources: 5,
  minimumPrimarySources: 1,
}
```

There are five entries: `agentic-ai`, `editor-ide`, `git-cli`, `databases-performance`, and `debugging-observability`. Registry validation runs at renderer startup and in unit tests. Slugs are immutable because they key history files and media paths.

The API never accepts caller-supplied scopes, queries, domains, or thresholds. n8n passes only a known topic slug and format, preventing a stale workflow copy from silently redefining a topic.

#### 2. Research retrieval service

Add `renderer/src/research-sources.mjs` and a thin route:

```text
POST /v1/research/sources
{ topicSlug, format, recentTopics, now? }
```

The production route ignores `now`; it is injectable only at the module boundary for tests.

The service builds a query pack from the registry:

- **Tips:** official documentation, manuals, release notes, repositories, and feature guides. Queries emphasize a specific action, flag, command, shortcut, or setting with a concrete payoff.
- **Trends:** recent official announcements, changelogs, releases, and credible reporting. Queries emphasize recency, named capabilities, and concrete developer workflow impact.

It queries the existing SearXNG service and supplements those results with topic-specific preferred sources. General feeds remain optional discovery inputs but receive no preferred-domain boost unless they match the active topic.

Every result is normalized to:

```js
{
  title,
  summary,
  source_url,
  publisher,
  published_at,
  retrieved_at,
  source_type: 'official-docs|official-changelog|repository|article|community',
  query,
  topic_slug,
  format,
  lexical_score,
  domain_score,
  recency_score,
  authority_score,
  relevance_score,
  relevance_reasons,
}
```

URLs are canonicalized and deduplicated before scoring. Existing public-address and response-size protections used by visual discovery are reused for any page fetches. Retrieval has fixed timeouts, a per-query result limit, a global source limit, and bounded concurrency.

#### 3. Hybrid relevance filter

The retrieval service filters before invoking the research model:

1. Required/excluded term checks against title, summary, publisher, and URL.
2. Preferred-domain and source-type scoring.
3. Format-specific recency scoring.
4. A constrained semantic classification for borderline results.

The semantic classifier returns only `{in_scope, confidence, reason}` for one registry scope and one source. It cannot invent research candidates. A source is admitted when it passes deterministic rules or receives sufficient classifier confidence; explicit exclusions always win.

Only the best 10-20 qualified sources are returned. This replaces the current 35-45 generic-source prompts and lowers model cost.

#### 4. Retrieval outcome contract

The endpoint returns one of two successful outcomes:

```js
{
  status: 'ready',
  topicSlug,
  format,
  sources,
  diagnostics: { queryCount, rawCount, dedupedCount, qualifiedCount, primaryCount }
}
```

or:

```js
{
  status: 'no_in_scope_research',
  topicSlug,
  format,
  sources: [],
  diagnostics,
  reason,
}
```

Network or internal failures use non-2xx responses and fail the execution. A normal evidence shortage uses HTTP 200 so n8n can route it deliberately rather than displaying a misleading parser failure.

#### 5. Two parameterized core workflows

Introduce:

- `Topic Research: Tips Core`
- `Topic Research: Trend Core`

Each accepts `{topicSlug}` through an Execute Workflow Trigger. The two cores share source retrieval and validation patterns but keep their distinct dialogue length, editorial schema, judge rubric, render budget, and visual requirements.

The existing ten named topic workflows become thin compatibility wrappers:

```text
existing execute-workflow trigger or dashboard webhook
  -> Attach immutable topicSlug
  -> Execute Tips Core or Trend Core
```

This preserves workflow names, IDs where possible, webhook paths, dashboard choices, history namespaces, audio paths, and operational visibility. The round-robin roster continues to dispatch the ten wrappers. Only the two core workflows contain the research, dialogue, visual, render, and publish pipeline.

The wrapper passes the topic slug; the core obtains all other configuration from the renderer registry. Format is determined by which core is called and is not caller-controlled.

#### 6. Research package validator

Add `renderer/src/research-package-validator.mjs` and route:

```text
POST /v1/research/validate
{ topicSlug, format, evidence, research }
```

Validation is fail-closed and enforces:

- `recommended_topic` exists and equals `candidates[0]` by normalized topic/tool identity.
- Candidate count is within the format policy.
- Every candidate passes the active topic scope classifier.
- Every factual claim cites a URL from the supplied evidence set.
- Every candidate has the required schema fields and at least one claim.
- At least one primary/official source supports the recommended candidate.
- Tips contain a specific action and concrete payoff that can fit the short format.
- Trends contain a supported `why_now`, recent evidence, and a concrete developer workflow.
- Previously rendered topics remain excluded through the existing namespaced history check.

The validator returns `{valid: true, research, diagnostics}` or `{valid: false, failureCode, reasons}`. Invalid model output never reaches dialogue generation.

#### 7. Independent editorial judge

Both core workflows include a final topic-aware judge before dialogue generation. Its prompt receives:

- Registry display name and scope.
- Explicit exclusions.
- Format rubric.
- Recommended candidate.
- Its cited evidence only.
- Deterministic validator diagnostics.

For Tips, this extends the existing novelty/payoff judge with topic membership and evidence checks. For Trends, it adds the missing equivalent gate. The judge can reject but cannot repair or replace a candidate. Rejection advances to the next validated candidate; exhaustion produces a clean `no_publishable_candidate` outcome.

## End-to-end data flow

```text
Round Robin / Dashboard
  -> Existing topic wrapper
  -> Attach topicSlug
  -> Tips Core or Trend Core
  -> Fetch namespaced history
  -> POST /v1/research/sources
       -> ready ------------------------------+
       -> no_in_scope_research -> record skip | -> finish successfully
  -> Build evidence-only research prompt      |
  -> Claude, with existing local fallback     |
  -> Normalize structural JSON                |
  -> POST /v1/research/validate <-------------+
       -> invalid -> one bounded research retry
       -> still invalid -> record skip -> finish successfully
  -> Topic-aware editorial judge
       -> rejected -> next validated candidate
       -> exhausted -> record skip -> finish successfully
  -> Dialogue
  -> Visual discovery and production gate
  -> Render
  -> Record rendered-topic history
  -> Publish
```

Research retry is bounded to one retry with validator feedback. Retrieval itself performs one bounded query expansion when the initial qualified count is below the configured minimum. No unbounded loops are introduced.

## Skip records and observability

Add a namespaced research-run log under `/media/research-runs/` or the existing editorial record system. Each run records:

- Topic slug and format.
- Workflow and execution IDs.
- Query and source counts.
- Qualified source URLs and relevance reasons.
- Selected and rejected candidates.
- Validation and judge decisions.
- Final outcome: `published`, `no_in_scope_research`, `invalid_research`, `no_publishable_candidate`, or `failed`.

Do not store API keys, authorization headers, full model headers, or unrelated page contents. Dashboard execution details continue to show node-level status; a later dashboard enhancement may surface these diagnostics but is not required for this implementation.

## Caching and cost controls

- Cache normalized retrieval results by `{topicSlug, format, UTC date}` for 12 hours.
- Cache is advisory: corrupt or expired entries are ignored and replaced.
- Cap query count, results per query, page bytes, and total admitted sources.
- Use deterministic filtering before semantic classification.
- Classify only borderline sources.
- Send at most 20 qualified sources to research.
- Judge candidates sequentially and stop at the first accepted candidate.
- Never invoke dialogue, image search, vision judging, TTS, or rendering for a skipped research run.

## Failure behavior

| Condition | Result |
|---|---|
| Too few relevant sources after bounded expansion | Successful skip: `no_in_scope_research` |
| Research provider unavailable and local fallback unavailable | Failed execution |
| Model returns invalid JSON | One retry; then successful skip: `invalid_research` |
| Candidate is off-topic or cites unknown URLs | Validator rejects; one retry; then skip |
| All validated candidates fail editorial judge | Successful skip: `no_publishable_candidate` |
| Retrieval service, filesystem, or internal API errors | Failed execution |
| Failure after rendering or during publishing | Existing fail-loud behavior remains |

Successful skips must not write rendered-topic history or publish to any platform.

## Migration

### Phase 1: Safety gates

Before changing retrieval, add the shared topic registry, research-package validator, topic-aware judge policy, no-result contract, and mixed-topic regression tests to the existing workers. This immediately prevents another off-topic publication.

### Phase 2: Topic-aware retrieval

Add the retrieval service and replace the eleven-feed fan-in in each existing worker with `/v1/research/sources`. Run all ten topic/format combinations in shadow mode with publishing disabled.

### Phase 3: Core workflow consolidation

Create the two parameterized core workflows, convert the ten existing workflows into wrappers, and update deployment synchronization. Preserve names, webhook paths, and history namespaces. Compare core outputs with the shadow runs before enabling publishing.

### Phase 4: Production rollout

Enable one topic pair at a time. Agentic AI canary runs first because the current source pool already performs best for that topic; Editor/IDE follows because it exposed both audited failure modes. Git/CLI, Databases/Performance, and Debugging/Observability follow after their shadow fixtures and live retrieval diagnostics pass.

Rollback is performed by pointing wrappers back to their previous full workflow version. Existing history and media paths remain compatible.

## Testing

### Renderer unit tests

- Registry validation: unique immutable slugs, complete topic definitions, legal domains and thresholds.
- Query generation differs by topic and format.
- URL canonicalization and deduplication.
- Preferred-domain, lexical, exclusion, authority, and recency scoring.
- Borderline semantic-classifier routing.
- Cache hit, expiry, and corrupt-cache recovery.
- Bounded concurrency, timeout, and maximum-response-size behavior.
- `ready` and `no_in_scope_research` contracts.
- Package validation for source membership, topic scope, candidate ordering, primary-source minimums, and format fields.
- Skip records redact secrets and contain required diagnostics.

### Workflow tests

- Each wrapper passes the correct immutable slug to the correct core.
- Tips and Trend cores cannot be invoked with an unknown slug.
- No-result retrieval ends successfully without reaching dialogue or publish nodes.
- Invalid research retries once and cannot reach dialogue.
- Tips and Trends both invoke the topic-aware judge.
- Exhausted candidates end as a successful skip.
- Rendered history is written only after successful render.
- Existing webhook paths, history namespaces, media paths, and platform branches remain unchanged.

### Adversarial fixtures

Every topic receives a fixture containing a mixture of all five topics. The test must prove that only in-scope sources and candidates survive. Include the audited regression cases:

- AI SDK Harness must be rejected for Editor/IDE.
- A VS Code or JetBrains native feature must be rejected for Agentic AI unless its evidence is specifically about an agentic editor capability permitted by that scope.
- A generic database launch must not qualify as a performance tip without a supported action and payoff.
- Generic AI news must not qualify for Git/CLI or Debugging/Observability.
- A model-generated claim URL absent from the evidence set must be rejected.
- A valid empty candidate result must produce `no_in_scope_research`, not `RESEARCH_INVALID_JSON`.

### Shadow validation

Run each of the ten topic/format combinations without publishing. Acceptance requires:

- 100% of selected candidates pass the deterministic scope gate.
- At least 80% of sources sent to the research model are manually judged relevant during the initial rollout sample.
- 100% of selected claims cite URLs from the supplied evidence set.
- Every selected candidate has at least one primary/official source.
- Zero recommendation/candidate-order mismatches.
- No-result runs finish as recorded successful skips.
- No skipped run reaches dialogue, visuals, TTS, render, history, or publishing.

## Deployment

1. Run renderer, workflow, dashboard, and deployment regression suites locally.
2. Sync the renderer and workflow definitions to `mac-agent` using the existing deployment path.
3. Import the two new core workflows once, then allow normal API synchronization to update them.
4. Keep publishing disabled for shadow executions.
5. Inspect research-run diagnostics for all ten combinations.
6. Enable production wrappers incrementally according to the rollout order.
7. Verify n8n execution data, rendered-topic history, and publication branches after each canary.

No new third-party credential is required. Retrieval uses the existing SearXNG service and existing research providers.

## Acceptance criteria

1. Every research run is parameterized by one registry topic slug and one fixed core format.
2. Topic-specific queries and preferred sources are used before model synthesis.
3. Generic source feeds cannot bypass the relevance filter.
4. Off-topic candidates cannot reach dialogue, render, history, or publishing.
5. All selected claim URLs belong to the exact evidence set supplied to the model.
6. Tips and Trends both have a topic-aware independent editorial judge.
7. A lack of qualified research is a successful, observable skip rather than an error.
8. The ten existing workflow names and dashboard entry points remain available through wrappers.
9. Research model input is capped at 20 qualified sources.
10. All ten topic/format combinations pass adversarial fixtures and shadow validation before production publishing is enabled.

## Explicit non-goals

- Automatically inventing a topic when current evidence is weak.
- Publishing a generic fallback topic under a topic-specific show.
- Replacing the existing visual production gate or platform publishing modules.
- Building a new dashboard interface in this change.
- Adding paid search providers or credentials.
- Backfilling or deleting existing rendered-topic history.
