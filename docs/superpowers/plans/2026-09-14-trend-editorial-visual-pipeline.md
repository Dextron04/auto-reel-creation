# Trend-Led Editorial Visual Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an evidence-driven, diverse topic pipeline that approves a relevant visual storyboard before generating dialogue, then blocks weak sequences before rendering or publishing.

**Architecture:** Add focused modules for discovery normalization, editorial ranking, visual preflight, dialogue mapping, and final sequence review. Thread their structured artifacts through the n8n workflow and renderer, persisting an auditable editorial record alongside existing topic history.

**Tech Stack:** Node.js ES modules, n8n workflow JSON, Express renderer, Remotion, Node test runner, existing Anthropic integration.

**Spec:** `docs/superpowers/specs/2026-09-14-trend-editorial-visual-pipeline-design.md`

## Global Constraints

- Practical developer value is 70% of ranking; audience momentum is 30%.
- Previously rendered topics remain permanently excluded.
- A storyboard must contain 8–12 approved distinct visuals covering at least 6 beats before dialogue.
- Vision approval is mandatory; heuristic fallback cannot auto-approve images.
- Dialogue is limited to verified claims and approved visual cues.
- Rendering/publishing stops on evidence, visual, mapping, sequence-review, or storage failure.
- Tests must use deterministic fixtures and dry-run publishing; no public post is performed.

### Task 1: Discovery signals and balanced candidate selection

**Files:**
- Create: `renderer/src/trend-discovery.mjs`
- Create: `renderer/src/trend-discovery.test.mjs`
- Modify: `n8n/workflows/research-and-render-reel.json`
- Test: `n8n/workflows/research-workflow.test.mjs`

**Interfaces:** `discoverTrends({sources, now, history}) -> {signals, rejected, diagnostics}`; `normalizeSignal(raw, source, now) -> signal`; `selectBalancedSignals(signals, limits) -> signal[]`.

- [ ] Write fixtures covering GitHub, HN, Product Hunt, Reddit/feed, vendor, and security signals, including absent metrics.
- [ ] Implement URL/product/title deduplication, category round-robin, publisher caps, and permanent topic-history exclusion.
- [ ] Add source adapters with clean optional-source degradation and explicit insufficient-evidence errors.
- [ ] Wire the workflow research node to emit the balanced normalized signal artifact.
- [ ] Run renderer and workflow tests; commit `feat: add balanced trend discovery`.

### Task 2: Editorial concept generation and ranking

**Files:**
- Create: `renderer/src/editorial.mjs`
- Create: `renderer/src/editorial.test.mjs`
- Modify: `n8n/workflows/research-and-render-reel.json`
- Test: `n8n/workflows/research-workflow.test.mjs`

**Interfaces:** `generateConcepts({signals, history, model}) -> concept[]`; `validateConcept(concept) -> {ok, reasons}`; `rankConcepts(concepts) -> concept[]`.

- [ ] Add fixtures for valid, duplicate, uncited, low-diversity, and same-category concepts.
- [ ] Implement 8–12 concept output validation and weighted 30/20/20/20/10 scoring.
- [ ] Enforce distinct top-three category selection and exact source URLs for claims.
- [ ] Pass only the top three concepts into visual preflight and persist scores/rejections.
- [ ] Run focused tests; commit `feat: rank evidence-backed editorial concepts`.

### Task 3: Visual storyboard preflight and asset judging

**Files:**
- Create: `renderer/src/visual-preflight.mjs`
- Create: `renderer/src/visual-preflight.test.mjs`
- Modify: `renderer/src/asset-discovery.mjs`, `renderer/src/asset-discovery.test.mjs`
- Modify: `n8n/workflows/research-and-render-reel.json`

**Interfaces:** `buildStoryboard(concept) -> beat[]`; `collectVisualCandidates(beat, providers) -> candidate[]`; `judgeVisual(candidate, beat, vision) -> scoredCandidate`; `approveStoryboard(storyboard) -> approval`.

- [ ] Add tests for beat query generation, candidate-type policy, rejected generic/mismatched/tiny assets, and eight-image/six-beat thresholds.
- [ ] Implement 8–12 beats with three query variants and exact source/stock eligibility metadata.
- [ ] Extend discovery to collect 12–20 PNG candidates, crop meaningful regions, and retain provenance.
- [ ] Require vision scores for relevance/correctness/readability/interest/distinctness; fail closed when unavailable.
- [ ] Add pacing, repeated-logo, repeated-crop, and cue metadata to the approved inventory.
- [ ] Run visual tests; commit `feat: gate dialogue on visual storyboard quality`.

### Task 4: Evidence-constrained dialogue and sequence review

**Files:**
- Create: `renderer/src/sequence-review.mjs`
- Create: `renderer/src/sequence-review.test.mjs`
- Modify: `renderer/src/dialogue.mjs`, `renderer/src/dialogue.test.mjs`
- Modify: `renderer/src/validation.mjs`, `renderer/src/server.mjs`
- Modify: `n8n/workflows/research-and-render-reel.json`

**Interfaces:** `generateDialogue({concept, claims, storyboard, model}) -> dialogue`; `validateDialogue(dialogue, storyboard) -> validation`; `reviewSequence({dialogue, visuals, vision}) -> review`.

- [ ] Add failing fixtures for unsupported claims, missing anchors, wrong beat order, and six-turn violations.
- [ ] Update dialogue generation to consume only approved claims/visuals and require exact spoken cue anchors.
- [ ] Implement one rewrite retry, then `DIALOGUE_STORYBOARD_MISMATCH` failure.
- [ ] Implement final multimodal review thresholds for relevance, coverage, variety, readability, pacing, and stock support.
- [ ] Block render/publish on `SEQUENCE_REVIEW_FAILED` and expose structured reasons in HTTP/n8n output.
- [ ] Run dialogue and sequence tests; commit `feat: review dialogue-to-visual sequence`.

### Task 5: Editorial record storage, workflow integration, and dry-run E2E

**Files:**
- Create: `renderer/src/editorial-record.mjs`
- Create: `renderer/src/editorial-record.test.mjs`
- Create: `scripts/verify-editorial-pipeline.mjs`
- Modify: `renderer/src/server.mjs`, `renderer/src/render-report.mjs`
- Modify: `n8n/workflows/research-and-render-reel.json`
- Modify: `README.md`

**Interfaces:** `writeEditorialRecord({runId, artifact, mediaDir}) -> path`; `readEditorialRecord(runId, mediaDir) -> record`; `runDryEditorialE2E(fixtures) -> report`.

- [ ] Test atomic record writes, stable run IDs, required fields, and storage-failure behavior.
- [ ] Persist discovery metrics, rejected items, concepts, visual scores, mappings, final review, and provider metadata.
- [ ] Update topic history only after successful render while linking the editorial record.
- [ ] Add deterministic dry-run E2E script that exercises all gates and never publishes externally.
- [ ] Run all unit, integration, renderer, workflow, and dry-run E2E tests; commit `feat: persist and verify editorial pipeline`.

### Task 6: Remote rollout and end-to-end verification

**Files:**
- No source changes; deploy committed changes to `/Users/mac-agent/auto-reel-creation`.

- [ ] Preserve unrelated remote staged/unstaged work with a named stash and verify it is restored unchanged.
- [ ] Apply the implementation commits, rebuild/restart renderer and n8n, and back up existing workflow/history records.
- [ ] Run remote unit/integration/dry-run E2E checks and verify duplicate-topic rejection plus visual-gate failures.
- [ ] Do not perform a public Instagram post; report that production publishing remains approval-gated.
- [ ] Record remote commit IDs, test output, and any rollback instructions.

## Verification Checklist

- [ ] `npm test` passes in `renderer`.
- [ ] Workflow JSON tests pass.
- [ ] `node scripts/verify-editorial-pipeline.mjs --dry-run` passes.
- [ ] `git diff --check` is clean for implementation changes.
- [ ] Remote renderer and n8n are healthy after rollout.
