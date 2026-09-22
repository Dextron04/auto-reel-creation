import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./distribution-daily-report.json', import.meta.url);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
const nodeByName = new Map(workflow.nodes.map((node) => [node.name, node]));

function runNodeCode(nodeName, {json, itemsByNode = {}} = {}) {
  const node = nodeByName.get(nodeName);
  assert.ok(node, `missing node ${nodeName}`);
  const $items = (name) => (itemsByNode[`${name}__items`] ?? [{json: itemsByNode[name]}]);
  const fn = new Function('$json', '$items', node.parameters.jsCode);
  return fn(json, $items);
}

test('the workflow is active and both triggers exist', () => {
  assert.equal(workflow.active, true);
  const types = workflow.nodes.map((node) => node.type);
  assert.ok(types.includes('n8n-nodes-base.scheduleTrigger'));
  assert.ok(types.includes('n8n-nodes-base.webhook'));
});

test('the daily schedule does not collide with the round-robin orchestrator or the two legacy shows', () => {
  const trigger = nodeById.get('distribution-schedule-trigger');
  const cron = trigger.parameters.rule.interval[0].expression;
  assert.equal(cron, '30 23 * * *');
  assert.doesNotMatch(cron, /^0 4,10,16,22/, 'must not fire at the same times as the topic orchestrator');
  assert.doesNotMatch(cron, /^0 \*\/6/);
  assert.doesNotMatch(cron, /30 1,7,13,19/);
});

test('the full chain is wired: triggers -> analyze -> build prompt -> Claude -> route -> attach -> email', () => {
  assert.equal(workflow.connections['Run Daily at 23:30'].main[0][0].node, 'Analyze Distribution Performance');
  assert.equal(workflow.connections['Run Report from Dashboard'].main[0][0].node, 'Analyze Distribution Performance');
  assert.equal(workflow.connections['Analyze Distribution Performance'].main[0][0].node, 'Build Narrative Prompt');
  assert.equal(workflow.connections['Build Narrative Prompt'].main[0][0].node, 'Write Distribution Report with Claude');
  assert.equal(workflow.connections['Write Distribution Report with Claude'].main[0][0].node, 'Route Narrative');
  assert.equal(workflow.connections['Route Narrative'].main[0][0].node, 'Attach Narrative to Report');
  assert.equal(workflow.connections['Attach Narrative to Report'].main[0][0].node, 'Email Distribution Report');
});

test('the email call hits the renderer email endpoint, carries the report date, and is not soft-failed away', () => {
  const node = nodeById.get('distribution-email-report');
  assert.equal(node.parameters.method, 'POST');
  assert.match(node.parameters.url, /\/v1\/distribution\/report\/email$/);
  assert.match(node.parameters.jsonBody, /date:\s*\$json\.date/);
  // A misconfigured SMTP account is worth surfacing as a failed execution, same reasoning as the
  // narrative-attach step: this is the actual deliverable, not bookkeeping.
  assert.equal(node.onError, undefined);
});

test('every connection target and every $()/$items() reference resolves to a real node', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const [from, def] of Object.entries(workflow.connections)) {
    assert.ok(names.has(from), `connection source '${from}' is not a node`);
    for (const branch of def.main ?? []) for (const target of branch) {
      assert.ok(names.has(target.node), `connection target '${target.node}' (from '${from}') is not a node`);
    }
  }
  const refPattern = /\$(?:items)?\('([^']+)'\)/g;
  for (const node of workflow.nodes) {
    const jsCode = node.parameters?.jsCode;
    if (!jsCode) continue;
    for (const match of jsCode.matchAll(refPattern)) {
      assert.ok(names.has(match[1]), `${node.name} references missing node '${match[1]}'`);
    }
  }
});

test('the analyze call hits the renderer distribution-analyze endpoint', () => {
  const node = nodeById.get('distribution-analyze');
  assert.equal(node.parameters.method, 'POST');
  assert.match(node.parameters.url, /\/v1\/distribution\/analyze$/);
});

test('the narrative-attach call hits the renderer narrative endpoint and is not soft-failed away', () => {
  const node = nodeById.get('distribution-attach-narrative');
  assert.equal(node.parameters.method, 'POST');
  assert.match(node.parameters.url, /\/v1\/distribution\/report\/narrative$/);
  // Unlike the picker's weights fetch (where a soft fail must never block a publish), this is the
  // one write that makes the report readable -- a failure here should surface as a failed
  // execution rather than being silently swallowed.
  assert.equal(node.onError, undefined);
});

test('the Claude narrative call never aborts the workflow, same fallback pattern as the Instagram caption call', () => {
  const node = nodeById.get('distribution-narrative-claude');
  assert.equal(node.onError, 'continueRegularOutput');
  assert.equal(node.parameters.options.response.response.neverError, true);
  assert.match(node.parameters.jsonBody, /ANTHROPIC_DISTRIBUTION_MODEL/);
});

test('Build Narrative Prompt produces a prompt referencing the report date and never throws on a minimal report', () => {
  const changed = {
    date: '2026-09-18',
    weightsChanged: true,
    skipReason: null,
    topPerformer: {slug: 'git-cli', format: 'tips', avgEngagementRate: 0.2, sampleCount: 3, weight: 0.18, previousWeight: 0.1},
    bottomPerformer: {slug: 'editor-ide', format: 'tips', avgEngagementRate: 0.01, sampleCount: 3, weight: 0.05, previousWeight: 0.1},
    leaderboard: [
      {slug: 'git-cli', format: 'tips', avgEngagementRate: 0.2, sampleCount: 3, weight: 0.18, previousWeight: 0.1},
      {slug: 'editor-ide', format: 'tips', avgEngagementRate: 0.01, sampleCount: 3, weight: 0.05, previousWeight: 0.1},
    ],
    arms: [
      {slug: 'git-cli', format: 'tips', sampleCount: 3},
      {slug: 'editor-ide', format: 'tips', sampleCount: 3},
      {slug: 'databases-performance', format: 'trend', sampleCount: 0},
    ],
  };
  const result = runNodeCode('Build Narrative Prompt', {json: changed});
  assert.match(result[0].json.prompt, /2026-09-18/);
  assert.match(result[0].json.prompt, /git-cli \(tips\)/);
  assert.match(result[0].json.prompt, /databases-performance \(trend\)/, 'arms with no samples this window should be called out');
  assert.deepEqual(result[0].json.report, changed);

  const insufficient = {date: '2026-09-19', weightsChanged: false, skipReason: 'INSUFFICIENT_SAMPLES', topPerformer: null, bottomPerformer: null, leaderboard: [], arms: []};
  const skippedResult = runNodeCode('Build Narrative Prompt', {json: insufficient});
  assert.match(skippedResult[0].json.prompt, /Not enough data yet/);
});

test('Route Narrative uses Claude\'s text when the call succeeds', () => {
  const report = {date: '2026-09-18', weightsChanged: true, topPerformer: {slug: 'git-cli', format: 'tips'}, bottomPerformer: {slug: 'editor-ide', format: 'tips'}};
  const claudeResponse = {
    statusCode: 200,
    body: {content: [{type: 'text', text: 'Git & CLI Tricks: Tips clearly won today, so its weight went up.'}]},
  };
  const result = runNodeCode('Route Narrative', {json: claudeResponse, itemsByNode: {'Build Narrative Prompt': {report}}});
  assert.equal(result[0].json.narrative, 'Git & CLI Tricks: Tips clearly won today, so its weight went up.');
  assert.equal(result[0].json.narrativeSource, 'claude');
  assert.equal(result[0].json.date, '2026-09-18');
});

test('Route Narrative falls back to a deterministic summary when Claude fails or returns nothing usable', () => {
  const report = {date: '2026-09-18', weightsChanged: true, skipReason: null, topPerformer: {slug: 'git-cli', format: 'tips'}, bottomPerformer: {slug: 'editor-ide', format: 'tips'}};
  for (const badResponse of [
    {statusCode: 500, body: {error: 'server error'}},
    {statusCode: 200, body: {content: []}},
    {statusCode: 200, body: {}},
  ]) {
    const result = runNodeCode('Route Narrative', {json: badResponse, itemsByNode: {'Build Narrative Prompt': {report}}});
    assert.equal(result[0].json.narrativeSource, 'fallback');
    assert.match(result[0].json.narrative, /git-cli/);
    assert.match(result[0].json.narrative, /editor-ide/);
  }
});

test('Route Narrative fallback also covers the insufficient-samples case without crashing', () => {
  const report = {date: '2026-09-19', weightsChanged: false, skipReason: 'INSUFFICIENT_SAMPLES', topPerformer: null, bottomPerformer: null};
  const result = runNodeCode('Route Narrative', {json: {statusCode: 500}, itemsByNode: {'Build Narrative Prompt': {report}}});
  assert.equal(result[0].json.narrativeSource, 'fallback');
  assert.match(result[0].json.narrative, /Not enough data yet/);
  assert.match(result[0].json.narrative, /INSUFFICIENT_SAMPLES/);
});
