// Live smoke test for the two failure points that have been breaking runs: visual discovery
// (/v1/visuals) and the production editorial gate (/v1/editorial/production-gate). Replays the
// real dialogue+cues from the "myc" run that failed with VISUAL_ANCHOR_MISSING:3 (the "myc
// just... stops" ellipsis) before that fix shipped, and shares one source page across two cues
// (stresses candidateMatchesCueSource). Skips research/dialogue-writing/TTS/render entirely, so
// it finishes in ~1-2 minutes instead of the full workflow's ~10+. Costs real search + Claude
// vision calls, same as a real run.
//
// Usage: RENDERER_URL=http://127.0.0.1:3001 node scripts/smoke-test-editorial-gate.mjs

const RENDERER_URL = process.env.RENDERER_URL ?? 'http://127.0.0.1:3001';

// This is the exact dialogue+cues from the real "myc" production run that failed with
// VISUAL_ANCHOR_MISSING:3 (the "myc just... stops" ellipsis) before that fix shipped. Replaying
// real previously-failing content is a stronger test than an improvised fixture.
const dialogue = [
  {speaker: 'peter', text: "So myc is this open-source memory layer for coding agents, and it solves the problem where your agent spends three days doing the same work over and over because it forgot why it rejected an approach in the first place.", turn_index: 0, audioPath: '/media/dialogue-0-peter.wav'},
  {speaker: 'stewie', text: 'Wait, why would an agent forget a decision it made just hours before?', turn_index: 1, audioPath: '/media/dialogue-1-stewie.wav'},
  {speaker: 'peter', text: "Because when your context window fills up, the system compacts it into a summary, and the old summaries just drop the reasoning—they keep the facts but lose the 'why'—so the agent wakes up with no memory of the decision at all.", turn_index: 2, audioPath: '/media/dialogue-2-peter.wav'},
  {speaker: 'stewie', text: "So you're saying myc just... stops that from happening, or does it actually capture something different?", turn_index: 3, audioPath: '/media/dialogue-3-stewie.wav'},
  {speaker: 'peter', text: "It has a PreCompact hook that fires right before compaction and saves the decision artifact—like 'rejected approach Y for performance reasons'—to a persistent memory layer, so when context resets, the agent sees that decision and never re-proposes Y.", turn_index: 4, audioPath: '/media/dialogue-4-peter.wav'},
  {speaker: 'stewie', text: "Okay, that's clever: save the reasoning before you throw away the conversation, and the agent actually respects its own past self—I can see why that matters for agents running for days.", turn_index: 5, audioPath: '/media/dialogue-5-stewie.wav'},
];

const REAL_SOURCE = 'https://dev.to/vitaly_ivasenko_cd7932e08/your-coding-agent-forgets-on-purpose-a-precompact-hook-is-where-you-save-it-3gn';
const REPO_SOURCE = 'https://github.com/vitaly-ivasenko/myc';

const visualCues = [
  {turn_index: 0, phrase: 'myc is this open-source memory layer for coding agents', query: 'myc GitHub repository README TypeScript Bun', kind: 'screenshot', visual_purpose: 'identity', source_url: REPO_SOURCE},
  {turn_index: 0, phrase: 'three days doing the same work over and over', query: 'developer frustrated repeating work timeline loop', kind: 'stock', visual_purpose: 'context', source_url: 'https://www.pexels.com'},
  {turn_index: 1, phrase: 'why would an agent forget a decision', query: 'agent question mark thinking UI conversation', kind: 'stock', visual_purpose: 'reaction', source_url: 'https://www.unsplash.com'},
  {turn_index: 2, phrase: 'context window fills up, the system compacts it', query: 'context window token limit diagram compaction', kind: 'screenshot', visual_purpose: 'mechanism', source_url: REAL_SOURCE},
  {turn_index: 2, phrase: 'old summaries just drop the reasoning', query: 'information loss compaction summary document', kind: 'stock', visual_purpose: 'context', source_url: 'https://www.pexels.com'},
  {turn_index: 3, phrase: 'myc just stops that from happening', query: 'myc PreCompact hook open source code TypeScript', kind: 'screenshot', visual_purpose: 'interface', source_url: REPO_SOURCE},
  {turn_index: 4, phrase: 'rejected approach Y for performance reasons', query: 'myc decision artifact rationale memory layer preservation', kind: 'screenshot', visual_purpose: 'evidence', source_url: REAL_SOURCE},
  {turn_index: 5, phrase: 'agent actually respects its own past self', query: 'agent decision respect architectural pattern validation', kind: 'stock', visual_purpose: 'outcome', source_url: 'https://www.unsplash.com'},
  {turn_index: 5, phrase: 'agents running for days', query: 'long-running process timer hours continuous work', kind: 'stock', visual_purpose: 'context', source_url: 'https://www.pexels.com'},
];

const research = {
  recommended_topic: {
    topic: 'myc: PreCompact Hook for Preserving Agent Decision Context',
    tool_name: 'myc',
    one_line_value: 'Open-source memory layer that preserves agent decision rationale before context compaction.',
    claims: [
      {claim_id: 'c1', statement: 'myc is open-source (MIT), built on Bun and TypeScript.', source_url: REAL_SOURCE},
      {claim_id: 'c2', statement: 'A PreCompact hook saves decisions before context compaction occurs.', source_url: REAL_SOURCE},
    ],
  },
};

const post = async (path, body) => {
  const res = await fetch(`${RENDERER_URL}${path}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const json = await res.json().catch(() => ({}));
  return {status: res.status, json};
};

const t0 = Date.now();
console.log(`[1/2] POST /v1/visuals — discovering ${visualCues.length} cues (real myc run content, includes the ellipsis line and a shared source page)...`);
const discovery = await post('/v1/visuals', {dialogue, visualCues, research, focus: research.recommended_topic.one_line_value});

if (discovery.status !== 200) {
  console.error(`FAIL: visual discovery returned ${discovery.status}`);
  console.error(JSON.stringify(discovery.json, null, 2));
  process.exit(1);
}

const {visualValidation, visuals, visualReport} = discovery.json;
console.log(`  -> distinctImages=${visualValidation?.distinctImages} coveredTurns=${visualValidation?.coveredTurns} (need >=8 distinct, 6 turns covered)`);
console.log(`  -> ${visuals.length} visuals picked, sources: ${[...new Set(visuals.map(v => new URL(v.sourceUrl).hostname))].join(', ')}`);
const noImageCues = visualReport.filter(r => r.status === 'no_image').length;
if (noImageCues) console.log(`  -> ${noImageCues} cue(s) got no image (see visualReport for reasons)`);

console.log(`[2/2] POST /v1/editorial/production-gate — dialogue + visual-selection + anchor check (sequence-review gate removed)...`);
const gate = await post('/v1/editorial/production-gate', discovery.json);
const {errors} = gate.json;

console.log(`  -> ok=${gate.json.ok} errors=${JSON.stringify(errors ?? [])}`);
const anchorMissing = errors?.some(e => e.startsWith('VISUAL_ANCHOR_MISSING'));
if (anchorMissing) console.log('  -> BUG: VISUAL_ANCHOR_MISSING fired on the ellipsis line despite phraseAnchorsTurn');

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${gate.json.ok ? 'PASS' : 'FAIL'} in ${elapsed}s`);
process.exit(gate.json.ok ? 0 : 1);
