import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./dev-tips-reel.json', import.meta.url);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
const code = (id) => nodeById.get(id).parameters.jsCode;

// A trivial stand-in for n8n's paired-item accessor: every lookup returns the same fixed state,
// which is all these single-branch tests need.
const pairedItem = (state) => (_name) => ({item: {json: state}});

test('every $items()/$() reference inside a Code node points at a node that actually exists', () => {
  // Reused code from the tool-trend workflow hardcodes node names by string (e.g.
  // $items('Build Research Prompt')) -- renaming the node this workflow copies that code into
  // (here, to "Build Tips Research Prompt") silently breaks the reference at runtime with n8n's
  // opaque "Referenced node doesn't exist" error, which the structural connection checks below
  // don't catch since they only look at the connections graph, not string literals inside jsCode.
  const names = new Set(workflow.nodes.map((node) => node.name));
  const refPattern = /\$(?:items)?\('([^']+)'\)/g;
  const offenders = [];
  for (const node of workflow.nodes) {
    const jsCode = node.parameters?.jsCode;
    if (!jsCode) continue;
    for (const match of jsCode.matchAll(refPattern)) {
      if (!names.has(match[1])) offenders.push(`${node.name} -> ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('neverError lives where the installed httpRequest node actually reads it', () => {
  // n8n's HttpRequest V3 node reads this at runtime via
  // getNodeParameter('options.response.response.neverError', ...) -- NOT the flatter
  // options.neverError shape the rest of this codebase (and n8n's own UI, apparently, for
  // already-stored older nodes) uses. Placing it flat means the field gets silently dropped the
  // moment this workflow is created/updated through the API, and the node throws instead of
  // falling back on a non-2xx response. A live run against production caught this the hard way
  // (a routine TOPIC_HISTORY_DUPLICATE 400 crashed the whole execution instead of being ignored).
  const needsNeverError = [
    'Fetch Recent Tips Topics', 'Research Tips with Claude', 'Judge Topic with Claude',
    'Record Rejected Topic', 'Write Tips Dialogue with Claude', 'Write Tips Instagram Caption with Claude',
  ];
  for (const name of needsNeverError) {
    const options = workflow.nodes.find((node) => node.name === name)?.parameters?.options ?? {};
    assert.equal(options.neverError, undefined, `${name}: neverError must not sit at the flat options.neverError path`);
    assert.equal(options.response?.response?.neverError, true, `${name}: neverError must sit at options.response.response.neverError`);
  }
});

test('the reel is a distinct, namespaced pipeline from the tool-trend show', () => {
  const trigger = workflow.nodes.find((node) => node.name === 'Run Tips Reel from Dashboard');
  assert.equal(trigger?.parameters?.path, 'tips-dashboard-run');
  assert.notEqual(trigger?.parameters?.path, 'reel-dashboard-run');

  const fetchRecent = nodeById.get('tips-fetch-recent-topics');
  assert.match(fetchRecent.parameters.url, /namespace=tips/);
  const select = nodeById.get('tips-select-unused-topic');
  assert.match(select.parameters.jsonBody, /namespace: 'tips'/);
  const record = nodeById.get('tips-record-topic-history');
  assert.match(record.parameters.jsonBody, /namespace: 'tips'/);
});

test('quality-rejected topics never poison the rendered-topic dedup gate', () => {
  // A topic the judge rejects for being weak is a completely different fact from a topic that
  // actually rendered. Recording both under the same "tips" namespace (an earlier bug) meant a
  // few rejected candidates permanently exhausted every future research batch's candidate pool,
  // since "Select Unused Tips Topic" checks that namespace to hard-block anything "already used".
  const select = nodeById.get('tips-select-unused-topic');
  assert.match(select.parameters.jsonBody, /namespace: 'tips'/);
  assert.doesNotMatch(select.parameters.jsonBody, /tips-rejected/);

  const reject = nodeById.get('tips-record-rejected-topic');
  assert.match(reject.parameters.jsonBody, /namespace: 'tips-rejected'/);

  const record = nodeById.get('tips-record-topic-history');
  assert.match(record.parameters.jsonBody, /namespace: 'tips'/);
  assert.doesNotMatch(record.parameters.jsonBody, /tips-rejected/);

  // The research prompt's exclusion archive should still see both pools, merged, as a soft hint.
  const fetchRecent = nodeById.get('tips-fetch-recent-topics');
  assert.match(fetchRecent.parameters.url, /namespace=tips&namespace=tips-rejected/);
});

test('the judge uses its own configurable model, independent of the research/dialogue default', () => {
  const judge = nodeById.get('tips-judge-claude');
  assert.match(judge.parameters.jsonBody, /ANTHROPIC_JUDGE_MODEL/);
  assert.match(judge.parameters.jsonBody, /claude-sonnet-5/);
  assert.doesNotMatch(judge.parameters.jsonBody, /claude-haiku/);

  const research = nodeById.get('tips-research-claude');
  assert.match(research.parameters.jsonBody, /ANTHROPIC_MODEL \|\| 'claude-haiku/);
});

test('research sourcing reuses the same 11 feeds and trend scorer as the tool-trend show', () => {
  assert.equal(nodeById.get('merge-research-feeds').parameters.numberInputs, 11);
  assert.ok(nodeById.get('score-developer-tool-trends'));
  assert.equal(workflow.connections['Score Developer Tool Trends'].main[0][0].node, 'Fetch Recent Tips Topics');
});

test('research cycle guard bounds the outer restart loop and resets per execution', () => {
  const run = (getStaticData, execution, json) => new Function('$getWorkflowStaticData', '$execution', '$json', code('tips-guard-research-cycle'))(getStaticData, execution, json);
  const store = {};
  const getStaticData = () => store;
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const result = run(getStaticData, {id: 'exec-1'}, {recent: []});
    assert.equal(result[0].json.research_cycle, cycle);
  }
  assert.throws(() => run(getStaticData, {id: 'exec-1'}, {recent: []}), /JUDGEMENT_EXHAUSTED_ALL_RESEARCH_CYCLES/);

  // A new execution must not inherit the previous run's exhausted counter.
  const fresh = run(getStaticData, {id: 'exec-2'}, {recent: []});
  assert.equal(fresh[0].json.research_cycle, 1);
});

test('tips research prompt targets a 10-15 second single-payoff format and excludes prior topics', () => {
  const scored = Array.from({length: 6}, (_, i) => ({json: {
    source_url: `https://example.com/${i}`, publisher: 'example.com', trend_score: 90 - i, title: `Item ${i}`,
  }}));
  const items = (name) => (name === 'Score Developer Tool Trends' ? scored : []);
  const run = (json) => new Function('$items', '$json', code('tips-build-research-prompt'))(items, json);

  const withoutHistory = run({recent: []});
  assert.match(withoutHistory[0].json.prompt, /10-15 second/);
  assert.match(withoutHistory[0].json.prompt, /why_not_obvious/);
  assert.match(withoutHistory[0].json.prompt, /concrete_payoff/);
  assert.doesNotMatch(withoutHistory[0].json.prompt, /PERMANENT EXCLUSION ARCHIVE/);

  const withHistory = run({recent: [{tool_name: 'Git Worktrees', topic: 'Parallel branches without stashing', category: 'git'}]});
  assert.match(withHistory[0].json.prompt, /PERMANENT EXCLUSION ARCHIVE.*Git Worktrees: Parallel branches without stashing \(git\)/s);
});

test('judgement queue puts the history-verified topic first and drops its own duplicate from the fallback list', () => {
  const recommended = {tool_name: 'Git Worktrees', topic: 'Parallel branches without stashing'};
  const duplicate = {tool_name: 'Git Worktrees', topic: 'Parallel branches without stashing'};
  const other = {tool_name: 'grep -A/-B', topic: 'Context lines without rereading a file'};
  const research = {recommended_topic: recommended, candidates: [duplicate, other]};

  const result = new Function('$json', code('tips-prepare-judgement-queue'))({research});
  assert.equal(result[0].json.judgement_queue.length, 2);
  assert.equal(result[0].json.judgement_queue[0], recommended);
  assert.equal(result[0].json.judgement_queue[1], other);
  assert.equal(result[0].json.judgement_index, 0);
});

test('judgement prompt asks whether the idea still earns a watch once the viewer already knows it', () => {
  const queue = [{tool_name: 'Git Worktrees', topic: 'x', hook: 'Stop stashing to switch branches', why_not_obvious: 'Buried under git help -a', concrete_payoff: 'No stash, no context loss'}];
  const result = new Function('$json', code('tips-build-judgement-prompt'))({judgement_queue: queue, judgement_index: 0});
  assert.match(result[0].json.prompt, /already read the full idea/i);
  assert.match(result[0].json.prompt, /Git Worktrees/);
  assert.match(result[0].json.prompt, /worth_it/);

  assert.throws(() => new Function('$json', code('tips-build-judgement-prompt'))({judgement_queue: [], judgement_index: 0}), /JUDGEMENT_QUEUE_EMPTY/);
});

test('Claude judgement router extracts the verdict text and falls back to Qwen on failure', () => {
  const state = {prompt: 'judge this', research: {recommended_topic: {}}, judgement_queue: [{}], judgement_index: 0, candidate: {tool_name: 'x'}};
  const $ = pairedItem(state);
  const run = (json) => new Function('$json', '$', code('tips-route-claude-judgement'))(json, $);

  const success = run({statusCode: 200, body: {content: [{type: 'text', text: '{"worth_it":true,"reason":"clear payoff"}'}]}});
  assert.equal(success[0].json.use_qwen_fallback, false);
  assert.equal(success[0].json.candidate.tool_name, 'x');

  const failure = run({statusCode: 500, body: {error: {type: 'server_error'}}});
  assert.equal(failure[0].json.use_qwen_fallback, true);
  assert.equal(failure[0].json.prompt, 'judge this');
});

test('judgement verdict fails closed on unparseable output and always swaps in the candidate under review', () => {
  const candidate = {tool_name: 'Git Worktrees', topic: 'x'};
  const state = {research: {recommended_topic: {tool_name: 'old'}, candidates: []}, candidate, judgement_queue: [candidate], judgement_index: 0};
  const $ = pairedItem(state);
  const run = (json) => new Function('$json', '$', code('tips-normalize-judgement'))(json, $);

  const worthy = run({response: '{"worth_it":true,"reason":"still earns a watch"}'});
  assert.equal(worthy[0].json.worth_it, true);
  assert.equal(worthy[0].json.research.recommended_topic, candidate);

  const rejected = run({response: '{"worth_it":false,"failure_mode":"headline_is_the_whole_tip"}'});
  assert.equal(rejected[0].json.worth_it, false);
  assert.equal(rejected[0].json.failure_mode, 'headline_is_the_whole_tip');

  const garbage = run({response: 'not json at all'});
  assert.equal(garbage[0].json.worth_it, false, 'an unparseable judge verdict must never default to shipping the video');
  assert.equal(garbage[0].json.failure_mode, 'judgement_unparseable');
});

test('advancing the candidate index reports whether the queue still has a fallback left', () => {
  const queue = [{tool_name: 'a'}, {tool_name: 'b'}];
  const runAt = (index) => new Function('$', code('tips-advance-candidate-index'))(pairedItem({judgement_queue: queue, judgement_index: index, research: {}}));

  const mid = runAt(0);
  assert.equal(mid[0].json.judgement_index, 1);
  assert.equal(mid[0].json.has_more_candidates, true);

  const exhausted = runAt(1);
  assert.equal(exhausted[0].json.judgement_index, 2);
  assert.equal(exhausted[0].json.has_more_candidates, false);
});

test('the judgement loop wiring routes rejection back to the queue and exhaustion back to research', () => {
  assert.equal(workflow.connections['Topic Worth Watching?'].main[0][0].node, 'Finalize SEO Brief');
  assert.equal(workflow.connections['Topic Worth Watching?'].main[1][0].node, 'Record Rejected Topic');
  assert.equal(workflow.connections['Record Rejected Topic'].main[0][0].node, 'Advance Candidate Index');
  assert.equal(workflow.connections['Advance Candidate Index'].main[0][0].node, 'More Candidates In Queue?');
  assert.equal(workflow.connections['More Candidates In Queue?'].main[0][0].node, 'Build Judgement Prompt');
  assert.equal(workflow.connections['More Candidates In Queue?'].main[1][0].node, 'Fetch Recent Tips Topics');
});

test('tips dialogue prompt asks for a four-turn script sized for 10-15 seconds', () => {
  const seoBriefItem = {json: {research: {recommended_topic: {tool_name: 'Git Worktrees', claims: [{statement: 'It exists.'}]}}, seo_brief: {primary_keyword: 'git worktrees'}}};
  const items = (name) => (name === 'Finalize SEO Brief' ? [seoBriefItem] : []);
  const result = new Function('$items', '$json', code('tips-script-prompt'))(items, {});

  assert.match(result[0].json.prompt, /exactly four/i);
  assert.match(result[0].json.prompt, /first 4-5 seconds/);
  assert.match(result[0].json.prompt, /10 words or fewer/);
  assert.match(result[0].json.prompt, /between 20 and 28/);
  assert.match(result[0].json.prompt, /2 words per second/);
  assert.match(result[0].json.prompt, /turn_index 0, 1, 2, and 3/);
});

test('Claude tips-dialogue router enforces four turns and a tight word budget', () => {
  const promptItem = {json: {prompt: 'write four turns', research: {recommended_topic: {tool_name: 'Git Worktrees'}}, seo_brief: {}}};
  const items = (name) => (name === 'Build Tips Dialogue Prompt' ? [promptItem] : []);
  const run = (json) => new Function('$json', '$items', code('tips-route-claude-dialogue'))(json, items);

  const validTurns = [
    {speaker: 'peter', text: 'Worktrees swap branches without ever touching your stash.'},
    {speaker: 'stewie', text: 'Nobody bothers, they just stash instead.'},
    {speaker: 'peter', text: 'Stashing loses context; worktrees keep both branches open.'},
    {speaker: 'stewie', text: 'Fine, that actually saves real time.'},
  ];
  const success = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: validTurns})}]}});
  assert.equal(success[0].json.use_qwen_fallback, false);

  // A real production run (2026-09-16) returned a well-formed, on-topic dialogue that measured
  // 23.04s of actual audio for 48 words -- about 2.08 words/second for this show's TTS voice, far
  // slower than this code originally assumed. The word-count ceiling here is calibrated against
  // that measured rate (32 words tops out around 15.4s) specifically so a dialogue this long is
  // caught HERE, before spending a TTS call, an image search, and the editorial gate on a script
  // that render.mjs's measured-audio durationBudget (max 18s) would reject anyway.
  const realProductionTurns = [
    {speaker: 'peter', text: 'One voice model, 97 languages, zero language detection code.'},
    {speaker: 'stewie', text: 'Yeah, but you still need custom WebSocket plumbing to make it work.'},
    {speaker: 'peter', text: 'AI Gateway handles the WebSocket integration in five lines and auto-switches languages for you.'},
    {speaker: 'stewie', text: "So I get cost tracking and failover without writing branching logic—that's actually solid."},
  ];
  const realProduction = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: realProductionTurns})}]}});
  assert.equal(realProduction[0].json.use_qwen_fallback, true, 'a 48-word dialogue measures ~23s at this voice\'s real speech rate and must be rejected before it reaches render');

  const wrongCount = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: validTurns.slice(0, 2)})}]}});
  assert.equal(wrongCount[0].json.use_qwen_fallback, true);

  const wayTooLong = validTurns.map((turn) => ({...turn, text: `${turn.text} ${'padding word '.repeat(15).trim()}`}));
  const long = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: wayTooLong})}]}});
  assert.equal(long[0].json.use_qwen_fallback, true, 'a genuinely runaway response should still be rejected');

  const tooShort = validTurns.map((turn) => ({...turn, text: 'Too short.'}));
  const short = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: tooShort})}]}});
  assert.equal(short[0].json.use_qwen_fallback, true);
  assert.match(short[0].json.fallback_reason, /invalid_dialogue/);
});

test('tips dialogue normalization requires exactly four alternating turns and namespaced audio paths', () => {
  const valid = {response: JSON.stringify({
    title: 'Git Worktrees', focus: 'Parallel branches',
    turns: [
      {speaker: 'peter', text: 'Worktrees swap branches without ever touching your stash.'},
      {speaker: 'stewie', text: 'Nobody bothers, they just stash instead.'},
      {speaker: 'peter', text: 'Stashing loses context; worktrees keep both branches open.'},
      {speaker: 'stewie', text: 'Fine, that actually saves real time.'},
    ],
    visuals: [{turn_index: 0, phrase: 'x', query: 'y'}],
  })};
  const jobs = new Function('$json', code('tips-dialogue-normalize'))(valid);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((job) => job.json.speaker), ['peter', 'stewie', 'peter', 'stewie']);
  assert.ok(jobs.every((job) => job.json.audio_path.startsWith('/media/tips-dialogue-')));

  const sixTurns = {response: JSON.stringify({turns: Array.from({length: 6}, (_, i) => ({speaker: i % 2 ? 'stewie' : 'peter', text: 'Six turns is the old show format now.'}))})};
  assert.throws(() => new Function('$json', code('tips-dialogue-normalize'))(sixTurns), /DIALOGUE_REQUIRES_FOUR_TURNS/);

  const tinyWordCount = {response: JSON.stringify({turns: [
    {speaker: 'peter', text: 'Hi.'}, {speaker: 'stewie', text: 'Ok.'}, {speaker: 'peter', text: 'Bye.'}, {speaker: 'stewie', text: 'Sure.'},
  ]})};
  assert.throws(() => new Function('$json', code('tips-dialogue-normalize'))(tinyWordCount), /DIALOGUE_WORD_COUNT/);
});

test('tips render job requires all four turns covered and sets a short-form duration budget', () => {
  const fullCoverage = Array.from({length: 4}, (_, i) => ({turn_index: i, phrase: 'Worktrees', query: 'git worktree screenshot'}));
  const jobs = Array.from({length: 4}, (_, i) => ({json: {speaker: i % 2 ? 'stewie' : 'peter', text: 'Meet worktrees', turn_index: i, audio_path: '/media/tips-dialogue-x.wav', visuals: fullCoverage}}));
  const items = (name) => (name === 'Normalize Tips Dialogue' ? jobs : [{json: {research: {recommended_topic: {tool_name: 'Git Worktrees'}}}}]);
  const result = new Function('$items', code('tips-render-prep'))(items);

  assert.equal(result[0].json.minimumImages, 4);
  assert.deepEqual(result[0].json.durationBudget, {minSeconds: 10, maxSeconds: 18});
  assert.equal(result[0].json.dialogue.length, 4);

  const gappyCues = [0, 0, 2, 2].map((turn_index) => ({turn_index, phrase: 'x', query: 'y'}));
  const gappyJobs = Array.from({length: 4}, (_, i) => ({json: {speaker: i % 2 ? 'stewie' : 'peter', text: 'Meet worktrees', turn_index: i, audio_path: '/media/tips-dialogue-x.wav', visuals: gappyCues}}));
  const gappyItems = (name) => (name === 'Normalize Tips Dialogue' ? gappyJobs : [{json: {research: {recommended_topic: {tool_name: 'Git Worktrees'}}}}]);
  assert.throws(() => new Function('$items', code('tips-render-prep'))(gappyItems), /DIALOGUE_CUES_MISSING_TURNS:2_OF_4/);
});
