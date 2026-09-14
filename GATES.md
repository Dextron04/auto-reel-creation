# Gates: seamless reel automation repair

OWNS: n8n/workflows/**, renderer/src/**, scripts/**, GATES.md

Scope: generated reels use natural-speed dialogue, end with the dialogue between 30 and 60 seconds, and include relevant downloaded visuals throughout the conversation.

- [x] G1: dialogue audio is never accelerated and render duration follows natural speech within the 30–60 second range
  CHECK: node scripts/verify-timing.mjs
  EXPECT: timing verification passed
  EVIDENCE: node scripts/verify-timing.mjs → "timing verification passed" (2026-09-13)

- [x] G2: every image cue resolves to a distinct, on-topic local PNG (page image, README image, or source-page screenshot) and is passed into the Remotion render job
  CHECK: node scripts/verify-visual-pipeline.mjs
  EXPECT: visual pipeline verification passed
  EVIDENCE: node scripts/verify-visual-pipeline.mjs → "visual pipeline verification passed" on run c39a… replay of execution 21: 5 judge-approved visuals, 3 cues rejected, no duplicates (2026-09-13)

- [x] G3: renderer regression tests pass
  CHECK: npm test && node -e "console.log('renderer regression suite passed')"
  EXPECT: renderer regression suite passed
  EVIDENCE: npm test → 33 pass, 0 fail (2026-09-13)

- [x] G4: n8n workflow regression tests pass
  CHECK: node --test n8n/workflows/research-workflow.test.mjs && node -e "console.log('workflow regression suite passed')"
  EXPECT: workflow regression suite passed
  EVIDENCE: node --test n8n/workflows/research-workflow.test.mjs → 26 pass, 0 fail (2026-09-14), incl. regressions for the truncated-fence RESEARCH_INVALID_JSON failure and the ANTHROPIC_MAX_TOKENS=4096 mid-JSON truncation (live-verified against claude-haiku-4-5-20251001: 4096 and 8192 both truncate the 5-candidate research schema with stop_reason=max_tokens; 16000 completes cleanly at end_turn, ~8767 output tokens used)

- [x] G5: a complete n8n execution produces a playable 9:16 reel with natural-speed speech, a measured duration from 30 through 60 seconds, subtitles, character switching, and topic visuals covering the dialogue without gaps
  CHECK: node scripts/verify-latest-reel.mjs
  EXPECT: end-to-end reel verification passed
  EVIDENCE: node scripts/verify-latest-reel.mjs on output/reel-verify-visuals-6.mp4 → "end-to-end reel verification passed"; 44.57 s, 36 captions, 6 character segments, 5 visuals covering the full dialogue (2026-09-13)

- [x] G6: sampled frames from the completed reel are visually reviewed for readable captions and relevant overlays during dialogue
  EVIDENCE: output/reel-verify-visuals-6.frames.png: 10 sampled frames, every one shows a judge-approved on-topic picture with readable captions; note the postmortem page holds ~20 s at the end because search was rate-limited and two cues were rejected (2026-09-13)
