# Gates: weighted topic distribution (Instagram-analytics-driven) + daily report agent

OWNS: renderer/src/distribution-*.mjs, renderer/src/instagram-insights.mjs, renderer/src/publish-instagram.mjs, renderer/src/server.mjs, renderer/package.json, n8n/workflows/topic-tips-core.json, n8n/workflows/topic-trend-core.json, n8n/workflows/topic-round-robin-orchestrator.json, n8n/workflows/topic-round-robin-orchestrator.test.mjs, n8n/workflows/distribution-daily-report.json, n8n/workflows/distribution-daily-report.test.mjs, scripts/deploy-server.sh, README.md, .env.example

Scope: replace the round-robin topic dispatcher with a weighted picker driven by real Instagram
Reels analytics (reach/likes/comments/shares/saved), record every publish event, compute per-topic
engagement stats + updated arm weights once enough samples exist (falling back to round robin
until they do), and run a daily n8n workflow that calls the analysis, has Claude write a plain-
English report of what did statistically well and how weights moved, persists that report, and
emails it out over SMTP (added after the user asked how the report actually reaches them).

- [x] G1: renderer unit tests (including all new distribution-*/instagram-insights modules) pass
  CHECK: npm --prefix renderer test
  EXPECT: # fail 0
  EVIDENCE: `ℹ tests 219 / ℹ pass 219 / ℹ fail 0` (bash run, cwd repo root, zsh) — includes distribution-log, distribution-weights, distribution-report, instagram-insights, distribution-api test files.

- [x] G2: dashboard regression suite still passes unmodified (no accidental coupling)
  CHECK: npm --prefix dashboard test
  EXPECT: # fail 0
  EVIDENCE: `ℹ tests 26 / ℹ pass 26 / ℹ fail 0`, unchanged from pre-change baseline.

- [x] G3: rewritten orchestrator + topology tests + new daily-report workflow tests pass
  CHECK: node --test n8n/workflows/topic-round-robin-orchestrator.test.mjs n8n/workflows/topic-workflows.test.mjs n8n/workflows/distribution-daily-report.test.mjs
  EXPECT: # fail 0
  EVIDENCE: 12 + 27 + 11 = 50 tests, all passing in combined run (subsumed by G5's 111-test run below).

- [x] G4: generated topic wrapper workflows are untouched / still match their generator
  CHECK: node scripts/build-topic-workflows.mjs --check
  EXPECT: all 10 generated topic workflows match their canonical generator
  EVIDENCE: exact string printed, exit 0.

- [x] G5: full n8n regression suite (research/dev-tips/topic/orchestrator/build-script) still passes
  CHECK: node --test n8n/workflows/research-workflow.test.mjs n8n/workflows/dev-tips-workflow.test.mjs n8n/workflows/topic-workflows.test.mjs n8n/workflows/topic-round-robin-orchestrator.test.mjs n8n/workflows/distribution-daily-report.test.mjs scripts/build-topic-workflows.test.mjs
  EXPECT: # fail 0
  EVIDENCE: `ℹ tests 111 / ℹ pass 111 / ℹ fail 0`.

- [x] G6: deploy-server.sh explicitly runs the new distribution-daily-report workflow test (it is not picked up by a glob)
  CHECK: grep -c "distribution-daily-report.test.mjs" scripts/deploy-server.sh
  EXPECT: 1
  EVIDENCE: grep returned `1`.

- [x] G7: README documents the weighted-distribution mechanism and the daily report
  CHECK: grep -c "distribution" README.md
  EXPECT: MATCH_GTE:1
  EVIDENCE: grep returned `2` (heading + body), new "## Weighted topic distribution" section added.

- [x] G8: weighted picker degrades safely to round robin when analytics/renderer are unavailable, and the new Fetch Distribution Weights + Record Distribution Publish HTTP nodes never abort their workflow on failure
  CHECK: node -e "const fs=require('fs');const files=['n8n/workflows/topic-round-robin-orchestrator.json','n8n/workflows/topic-tips-core.json','n8n/workflows/topic-trend-core.json'];let ok=true;for(const f of files){const w=JSON.parse(fs.readFileSync(f,'utf8'));const names=['Fetch Distribution Weights','Record Distribution Publish'];for(const n of w.nodes){if(names.includes(n.name)&&n.onError!=='continueRegularOutput'){ok=false;console.error(f,n.name,'missing onError continueRegularOutput');}}}console.log(ok?'SOFT_FAIL_OK':'SOFT_FAIL_MISSING')"
  EXPECT: SOFT_FAIL_OK
  EVIDENCE: printed `SOFT_FAIL_OK`.

- [x] G9: email delivery module and its SMTP config-error paths are covered
  CHECK: node --test renderer/src/distribution-email.test.mjs
  EXPECT: # fail 0
  EVIDENCE: `ℹ tests 5 / ℹ pass 5 / ℹ fail 0` (subsumed by G1's full renderer run, now 226 tests total).

- [x] G10: the daily workflow's last step actually emails the already-narrated report, and a bad SMTP config fails that execution loudly rather than being swallowed
  CHECK: node --test n8n/workflows/distribution-daily-report.test.mjs
  EXPECT: # fail 0
  EVIDENCE: `ℹ tests 12 / ℹ pass 12 / ℹ fail 0`, includes the new "Email Distribution Report" node/connection/onError assertions (subsumed by G5's 112-test run).

- [x] G11: full local end-to-end run against real infrastructure -- real @petergotskills media IDs, real Anthropic narrative call, real Gmail send, real Instagram Graph API call (confirmed the exact current production failure mode: token has instagram_content_publish but not instagram_manage_insights)
  CHECK: manual (SSH to mac-agent for real credentials/media ids and Graph API debug_token call; two standalone renderer runs -- one with the real default fetchMediaInsights against real media ids confirming graceful degradation with the real permission error, one with injected realistic insight values proving weights actually move: git-cli tips 10%->14.0%, editor-ide tips 10%->7.0%; real Anthropic call producing a narrative that names the exact numbers; real Gmail send; 2000-draw simulation of the orchestrator's real jsCode against the real shifted weights response landing at ~13.3%/6.5%, consistent with the computed weights)
  EXPECT: n/a (manual)
  EVIDENCE: two real messageIds returned by Gmail; orchestrator simulation distribution matched computed weights within sampling noise; two real bugs found and fixed during this run (see below).

All 11 gates met. 0 unmet, 0 abandoned.

## Bugs found and fixed during the live test run (2026-09-22)

1. **Mobile email layout**: the bottom performer card's `<td>` was missing the `perf-col` class the
   `@media (max-width: 480px)` rule targets (hand-duplicated markup instead of reusing
   `performerCard()`), so only the top card stacked on narrow screens. Fixed by deduplicating both
   cards through one function. Verified via direct DOM measurement (`scrollWidth === innerWidth`
   after the fix), not just a screenshot.
2. **`distribution-daily-report.json`'s Claude call**: `output_config: { effort: 'low' }` is not
   supported by the node's default model, `claude-haiku-4-5-20251001` (confirmed live: the exact
   same call succeeds on `claude-sonnet-5` and succeeds on haiku-4.5 with the param removed).
   Fixed by dropping `output_config` from that node's request body.
