import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./topic-round-robin-orchestrator.json', import.meta.url);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

function pickerCode() {
  return nodeById.get('orchestrator-pick-next-topic').parameters.jsCode;
}

function roster() {
  const match = pickerCode().match(/const roster = (\[.*?\]);/s);
  assert.ok(match, 'could not find roster literal in Pick Next Topic Worker');
  return JSON.parse(match[1]);
}

function run(store, jsonInput = {}) {
  const fn = new Function('$getWorkflowStaticData', '$json', pickerCode());
  return fn(() => store, jsonInput);
}

// Uniform weights across the whole roster, keyed the same way the renderer's
// GET /v1/distribution/weights response shapes them.
function uniformWeightsInput() {
  return {weights: roster().map((entry) => ({slug: entry.slug, format: entry.format, weight: 1 / roster().length}))};
}

test('the orchestrator has no schedule collision with the two independently-scheduled shows', () => {
  const trigger = nodeById.get('orchestrator-schedule-trigger');
  assert.equal(trigger.parameters.rule.interval[0].expression, '0 4,10,16,22 * * *');
  // The tool-trend show fires at 00/06/12/18:00 and the general tips show at 01:30/07:30/13:30/19:30
  // -- this is offset from both so three schedules don't all wake the renderer at once.
  assert.doesNotMatch(trigger.parameters.rule.interval[0].expression, /^0 \*\/6/);
  assert.doesNotMatch(trigger.parameters.rule.interval[0].expression, /30 1,7,13,19/);
});

test('the roster has exactly 10 entries (5 topics x 2 formats) with unique workflow ids and unique topic/format pairs', () => {
  const entries = roster();
  assert.equal(entries.length, 10);
  const ids = entries.map((entry) => entry.workflowId);
  assert.equal(new Set(ids).size, 10, 'roster contains a duplicate workflow id');
  const pairs = entries.map((entry) => `${entry.slug}:${entry.format}`);
  assert.equal(new Set(pairs).size, 10, 'roster contains a duplicate topic/format pair');
  for (const entry of entries) {
    assert.match(entry.workflowId, /^[A-Za-z0-9]+$/, `suspicious workflow id: ${entry.workflowId}`);
    assert.match(entry.workflowName, /: (Tips|Trend) Reel$/);
    assert.match(entry.slug, /^[a-z-]+$/);
    assert.ok(entry.format === 'tips' || entry.format === 'trend');
  }
  const tipsCount = entries.filter((entry) => entry.workflowName.endsWith('Tips Reel')).length;
  const trendCount = entries.filter((entry) => entry.workflowName.endsWith('Trend Reel')).length;
  assert.equal(tipsCount, 5);
  assert.equal(trendCount, 5);
});

test('every roster slug is a topic-format pair, one of each of the 5 topics x 2 formats', () => {
  const entries = roster();
  const bySlug = new Map();
  for (const entry of entries) {
    if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, new Set());
    bySlug.get(entry.slug).add(entry.format);
  }
  assert.equal(bySlug.size, 5);
  for (const formats of bySlug.values()) assert.deepEqual([...formats].sort(), ['tips', 'trend']);
});

test('with no weights available (renderer unreachable or cold start), the picker falls back to round robin and advances/wraps through the whole roster', () => {
  const store = {};
  const first = run(store, {});
  assert.equal(first.length, 1);
  assert.equal(first[0].json.selectionMode, 'round-robin');
  assert.equal(first[0].json.rotationIndex, 0);
  assert.equal(first[0].json.rosterSize, 10);
  assert.equal(first[0].json.weight, null);

  const seenIndices = [first[0].json.rotationIndex];
  for (let i = 1; i < 10; i += 1) seenIndices.push(run(store, {})[0].json.rotationIndex);
  assert.deepEqual(seenIndices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const wrapped = run(store, {});
  assert.equal(wrapped[0].json.rotationIndex, 0);
  assert.equal(wrapped[0].json.workflowId, first[0].json.workflowId);
});

test('round-robin fallback state is keyed off the same static data object across calls, not reset each time', () => {
  const storeA = {};
  const storeB = {};

  run(storeA, {});
  run(storeA, {});
  const thirdOnA = run(storeA, {});
  assert.equal(thirdOnA[0].json.rotationIndex, 2, 'storeA should have advanced independently');

  const firstOnB = run(storeB, {});
  assert.equal(firstOnB[0].json.rotationIndex, 0, 'a fresh static data object must start the rotation over, not inherit storeA\'s position');
});

test('a weights response missing even one roster arm is treated as unusable and falls back to round robin entirely, not partial weighting', () => {
  const entries = roster();
  const incomplete = {weights: entries.slice(1).map((entry) => ({slug: entry.slug, format: entry.format, weight: 1 / entries.length}))};
  const result = run({}, incomplete);
  assert.equal(result[0].json.selectionMode, 'round-robin');
});

test('all-zero weights (e.g. every arm freshly clamped to zero by a bug) is treated as unusable and falls back to round robin', () => {
  const entries = roster();
  const allZero = {weights: entries.map((entry) => ({slug: entry.slug, format: entry.format, weight: 0}))};
  const result = run({}, allZero);
  assert.equal(result[0].json.selectionMode, 'round-robin');
});

test('with a full weights response, the picker selects by weighted probability, not the static-data rotation', () => {
  const originalRandom = Math.random;
  try {
    const entries = roster();
    const skewed = {weights: entries.map((entry, index) => ({slug: entry.slug, format: entry.format, weight: index === 3 ? 0.91 : 0.01}))};
    // Cumulative weight before arm 3 is 0.03 (three arms at 0.01) and reaches 0.94 through arm 3
    // (0.03 + 0.91) out of a total weight of 1.0 -- rolling exactly 0.5 must land inside arm 3.
    Math.random = () => 0.5;
    const result = run({}, skewed);
    assert.equal(result[0].json.selectionMode, 'weighted');
    assert.equal(result[0].json.workflowId, entries[3].workflowId, 'the roll should have landed on the heavily-weighted arm');
    assert.equal(result[0].json.rotationIndex, null, 'weighted picks must not consume round-robin state');
    assert.ok(result[0].json.weight > 0);
  } finally {
    Math.random = originalRandom;
  }
});

test('a weighted pick does not advance the round-robin fallback counter', () => {
  const store = {};
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.5;
    run(store, uniformWeightsInput());
    run(store, uniformWeightsInput());
    assert.equal(store.nextTopicIndex, undefined, 'weighted picks must never touch nextTopicIndex');
  } finally {
    Math.random = originalRandom;
  }
});

test('the dispatch node fires the selected sub-workflow without blocking on its completion', () => {
  const dispatch = nodeById.get('orchestrator-dispatch');
  assert.equal(dispatch.type, 'n8n-nodes-base.executeWorkflow');
  assert.equal(dispatch.parameters.source, 'database');
  assert.equal(dispatch.parameters.workflowId, '={{$json.workflowId}}');
  assert.equal(dispatch.parameters.options.waitForSubWorkflow, false, 'the orchestrator should dispatch and return immediately, not sit running for the sub-workflow\'s full render+publish duration');
});

test('both triggers feed the weights fetch, which feeds the picker, which feeds the dispatcher', () => {
  assert.equal(workflow.connections['Dispatch Four Times Daily'].main[0][0].node, 'Fetch Distribution Weights');
  assert.equal(workflow.connections['Run Orchestrator from Dashboard'].main[0][0].node, 'Fetch Distribution Weights');
  assert.equal(workflow.connections['Fetch Distribution Weights'].main[0][0].node, 'Pick Next Topic Worker');
  assert.equal(workflow.connections['Pick Next Topic Worker'].main[0][0].node, 'Dispatch Selected Topic Worker');
});

test('Fetch Distribution Weights never aborts the orchestrator when the renderer is down or returns an error', () => {
  const node = nodeById.get('orchestrator-fetch-weights');
  assert.equal(node.type, 'n8n-nodes-base.httpRequest');
  assert.equal(node.parameters.method, 'GET');
  assert.match(node.parameters.url, /\/v1\/distribution\/weights$/);
  assert.equal(node.onError, 'continueRegularOutput', 'a network-level failure must not stop dispatch');
  assert.equal(node.parameters.options.response.response.neverError, true, 'a non-2xx renderer response must not throw either');
});
