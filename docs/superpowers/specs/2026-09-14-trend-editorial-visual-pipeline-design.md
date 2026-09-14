# Trend-Led Editorial and Visual Pipeline Design

## Objective

Replace the current prompt-led topic and visual workflow with an evidence-driven editorial pipeline that discovers a broad range of timely developer topics, measures real audience momentum, proves that a topic has compelling visuals, and only then writes dialogue.

The finished system must:

- Find current tools, releases, techniques, security events, and engineering developments across AI agents, skills, harnesses, coding tools, testing, observability, deployment, databases, programming languages, local AI, and adjacent developer infrastructure.
- Rank ideas primarily by practical developer value while still rewarding genuine audience interest.
- Produce distinct, useful video concepts rather than minor variations of the same product category.
- Gather and approve enough specific, engaging visuals before dialogue generation.
- Write dialogue around verified claims and an approved visual storyboard.
- Block rendering and publishing when evidence, visual relevance, or coverage is weak.

## Editorial Principles

The ranking objective is 70% developer usefulness and 30% audience momentum.

Developer usefulness measures whether the subject changes a real workflow, solves a recognizable pain, has a concrete audience, and can be explained with evidence. Audience momentum measures recent engagement and acceleration rather than raw lifetime popularity.

No single source, vendor, or topic category may dominate a run. Previously rendered tools and substantially equivalent topics remain permanently excluded by the existing topic-history layer.

## Architecture

The pipeline is divided into five independently testable stages:

1. Trend discovery
2. Editorial concept generation and ranking
3. Visual preflight and storyboard approval
4. Evidence-constrained dialogue writing
5. Final sequence review, rendering, and publishing

Each stage emits a structured artifact that becomes the only input to the next stage. A stage may reject a candidate, but it may not silently weaken its acceptance criteria.

## 1. Trend Discovery

### Sources

Discovery combines complementary signal types instead of relying primarily on vendor RSS feeds:

- GitHub releases and recently accelerating repositories for concrete adoption and development activity.
- Hacker News top, best, new, and Show HN stories with score and comment counts.
- Product Hunt developer and AI launches with vote and discussion signals when API credentials and permitted usage are configured.
- Developer-community discussions from configured Reddit communities and other permitted public feeds.
- DEV and engineering publications.
- Official product, framework, model, and platform release feeds.
- Security advisories, language releases, database releases, benchmark announcements, and major engineering postmortems.

Optional authenticated sources must degrade cleanly. Their absence may reduce confidence but must not collapse the entire discovery run.

### Normalized Signal

Every source is normalized to:

```json
{
  "signal_id": "source-stable-id",
  "title": "",
  "summary": "",
  "source_url": "",
  "publisher": "",
  "published_at": "",
  "retrieved_at": "",
  "category": "",
  "engagement": {
    "score": 0,
    "comments": 0,
    "stars": 0,
    "star_velocity": 0,
    "votes": 0
  },
  "authority_score": 0,
  "developer_relevance": 0
}
```

Unavailable engagement fields remain absent or null; they are never invented.

### Diversity and Deduplication

Canonical URLs, normalized product names, repository identities, and title similarity collapse duplicate coverage. Signals are bucketed by category and publisher. Selection round-robins categories and caps publisher representation before editorial analysis.

## 2. Editorial Concepts and Ranking

The research model receives the balanced signal set and produces 8–12 concepts, not a single recommendation. Each concept includes:

- A specific topic and tool or technology.
- A developer pain and concrete workflow change.
- Intended audience.
- A factual “why now.”
- Two or more hook options.
- Evidence-backed claims with exact source URLs.
- Audience-momentum evidence.
- Expected visual opportunities.
- Risks, caveats, and reasons the concept might be rejected.

Deterministic validation removes concepts with missing citations, archived topics, unsupported claims, or insufficient source diversity.

Remaining concepts receive a weighted score:

| Dimension | Weight |
| --- | ---: |
| Concrete developer usefulness | 30% |
| Workflow clarity and teachability | 20% |
| Evidence quality and source diversity | 20% |
| Current audience momentum | 20% |
| Hook and visual potential | 10% |

The usefulness, workflow, and evidence dimensions form the 70% practical-value side of the editorial objective. Momentum and hook potential form the 30% audience side.

The top three distinct concepts advance to visual preflight in rank order. Concepts from the same narrow product category cannot occupy all three slots.

## 3. Visual Preflight

### Storyboard Before Dialogue

Each advancing concept gets an 8–12 beat storyboard. Every beat describes:

- The fact or idea to communicate.
- Visual purpose: identity, interface, mechanism, evidence, outcome, reaction, or context.
- Preferred asset types.
- Three focused search-query variants.
- Relevant official, documentation, repository, article, or community URLs.
- Whether relevant stock imagery is acceptable.

Stock imagery is allowed for abstract context, emotion, analogy, or human workflow. It is not acceptable as proof of a product capability or as a substitute for a named product's interface.

### Candidate Collection

The collector gathers 12–20 usable PNG candidates per concept from:

- Official product pages and documentation.
- GitHub README images and repository assets.
- Product interfaces and terminal or editor screenshots.
- Architecture diagrams and code examples.
- Benchmark charts and cited evidence.
- Community reaction screenshots where permitted and legible.
- Image search results tied to the exact beat query.
- Relevant stock photos for eligible context beats.

Page screenshots are cropped around meaningful content elements rather than fixed full-page bands whenever possible. Navigation, cookie banners, generic article headers, unrelated products, tiny UI, and repeated artwork are rejected.

### Vision Scoring

The vision judge scores each candidate from 0–5 on:

- Exact relevance to the beat.
- Product and factual correctness.
- Mobile readability.
- Visual interest and composition.
- Distinctness from already selected assets.

A candidate must meet a configurable minimum on relevance and correctness and a minimum total score. The judge must explain rejections. The heuristic fallback may rank candidates for inspection but cannot auto-approve an image when the vision judge is unavailable.

The storyboard passes only with at least eight approved, distinct images covering at least six different beats. Visuals should normally change every 3–5 seconds. No logo may be used more than once, and no single page crop may dominate the sequence.

If a concept fails, the next editorial concept is preflighted. If all three fail, the run stops before dialogue generation.

## 4. Evidence-Constrained Dialogue

The dialogue writer receives only:

- The selected concept.
- Verified claims and source URLs.
- The approved storyboard and visual inventory.
- Required beat order and timing budget.

The writer creates six alternating Peter and Stewie turns while covering the storyboard beats naturally. Each visual cue includes an exact phrase present in its assigned turn. Dialogue may not introduce a factual claim that lacks evidence or a visual concept that was not approved during preflight.

The result includes stable visual asset IDs, exact spoken anchors, and intended ordering. A deterministic validator checks speaker order, phrase presence, claim references, cue coverage, and duration constraints.

One automatic rewrite is allowed when anchors or coverage fail. A second failure stops the run.

## 5. Final Sequence Review

Before rendering, a final multimodal review evaluates the complete dialogue-to-image sequence rather than isolated images. It checks:

- Whether every image matches what is being said at that moment.
- Whether the sequence has enough visual variety and pacing.
- Whether product screenshots and evidence are readable on a phone.
- Whether stock imagery supports rather than misrepresents the claim.
- Whether long holds, repeated page crops, or unrelated visual jumps remain.

The sequence must meet minimum relevance, coverage, and variety scores. Failure blocks rendering and publishing.

## Storage and Observability

Each run stores an editorial record containing:

- Normalized discovery signals and engagement data.
- Deduplicated and rejected signals with reasons.
- Generated concepts and component scores.
- Visual candidates, scores, judge explanations, and rejection reasons.
- The approved storyboard and dialogue mapping.
- Final sequence scores.
- Provider/model metadata and timestamps.

The record is written under the shared media volume using a stable run ID. Topic history references the successful editorial record after rendering. This allows future debugging without inspecting opaque n8n execution payloads.

## Failure Behavior

- Insufficient trend evidence: stop with `TREND_DISCOVERY_INSUFFICIENT`.
- No valid editorial concepts: stop with `EDITORIAL_NO_VALID_CONCEPT`.
- All shortlisted concepts lack visuals: stop with `VISUAL_PREFLIGHT_FAILED`.
- Vision judge unavailable: stop visual approval; never guess.
- Dialogue cannot satisfy evidence or anchors after one rewrite: stop with `DIALOGUE_STORYBOARD_MISMATCH`.
- Final relevance, variety, or coverage below threshold: stop with `SEQUENCE_REVIEW_FAILED`.
- Storage failure: stop the run so memory and audit records are not silently lost.

Failures must include the run ID, stage, candidate, and actionable reason in both n8n output and the editorial record.

## Testing Strategy

### Unit Tests

- Normalize each discovery source without fabricating unavailable metrics.
- Deduplicate cross-posted stories and product-name variants.
- Enforce publisher caps and category round-robin behavior.
- Calculate editorial scores from fixed fixtures.
- Reject archived topics and unsupported concepts.
- Enforce stock-photo eligibility by beat purpose.
- Score and threshold visual candidates.
- Reject duplicate images, repeated logos, and dominant page crops.
- Validate exact dialogue anchors and evidence references.
- Enforce minimum visual count, beat coverage, and pacing.

### Integration Tests

- Replay fixed source fixtures through discovery and concept ranking.
- Replay stored HTML, README, search, and image fixtures through visual preflight.
- Verify that a visually weak first concept advances to the second concept before dialogue.
- Verify that dialogue generation never starts when all concepts fail preflight.
- Verify editorial records and topic-history linkage.

### End-to-End Dry Run

A dedicated dry-run input executes discovery, research, visual preflight, dialogue, TTS, and rendering while replacing Instagram publication with a recorded no-op result. The test verifies:

- A topic absent from permanent history was selected.
- At least eight approved PNGs are present.
- Visuals cover at least six storyboard beats.
- Every cue phrase exists in dialogue.
- Visual coverage spans at least 90% of spoken time.
- No image is reused.
- The final multimodal sequence review passes.
- No external post is created.

Production publishing remains a separate explicitly authorized verification step.

## Rollout

The new stages will be introduced behind a workflow configuration flag. Fixture-based tests and dry-run end-to-end verification must pass before the flag becomes the default. The old post-dialogue collector remains available for rollback until one successful reviewed production reel completes through the new path.
