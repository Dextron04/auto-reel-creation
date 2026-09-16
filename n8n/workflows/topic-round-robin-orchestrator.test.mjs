import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./topic-round-robin-orchestrator.json', import.meta.url);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

test('the orchestrator has no schedule collision with the two independently-scheduled shows', () => {
  const trigger = nodeById.get('orchestrator-schedule-trigger');
  assert.equal(trigger.parameters.rule.interval[0].expression, '0 4,10,16,22 * * *');
  // The tool-trend show fires at 00/06/12/18:00 and the general tips show at 01:30/07:30/13:30/19:30
  // -- this is offset from both so three schedules don't all wake the renderer at once.
  assert.doesNotMatch(trigger.parameters.rule.interval[0].expression, /^0 \*\/6/);
  assert.doesNotMatch(trigger.parameters.rule.interval[0].expression, /30 1,7,13,19/);
});

test('the roster has exactly 10 entries (5 topics x 2 formats) with unique workflow ids', () => {
  const code = nodeById.get('orchestrator-pick-next-topic').parameters.jsCode;
  const match = code.match(/const roster = (\[.*?\]);/s);
  assert.ok(match, 'could not find roster literal in Pick Next Topic Worker');
  const roster = JSON.parse(match[1]);
  assert.equal(roster.length, 10);
  const ids = roster.map((entry) => entry.workflowId);
  assert.equal(new Set(ids).size, 10, 'roster contains a duplicate workflow id');
  for (const entry of roster) {
    assert.match(entry.workflowId, /^[A-Za-z0-9]+$/, `suspicious workflow id: ${entry.workflowId}`);
    assert.match(entry.workflowName, /: (Tips|Trend) Reel$/);
  }
  const tipsCount = roster.filter((entry) => entry.workflowName.endsWith('Tips Reel')).length;
  const trendCount = roster.filter((entry) => entry.workflowName.endsWith('Trend Reel')).length;
  assert.equal(tipsCount, 5);
  assert.equal(trendCount, 5);
});

test('round-robin picking advances through the whole roster and wraps back to the start', () => {
  const code = nodeById.get('orchestrator-pick-next-topic').parameters.jsCode;
  const store = {};
  const getWorkflowStaticData = () => store;
  const run = () => new Function('$getWorkflowStaticData', code)(getWorkflowStaticData);

  const first = run();
  assert.equal(first[0].json.rotationIndex, 0);
  assert.equal(first[0].json.rosterSize, 10);

  const seenIndices = [first[0].json.rotationIndex];
  for (let i = 1; i < 10; i += 1) seenIndices.push(run()[0].json.rotationIndex);
  assert.deepEqual(seenIndices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // The 11th call must wrap back to the first roster entry, not run off the end or reset to a
  // stale default -- this is the entire point of persisting state in workflow static data.
  const wrapped = run();
  assert.equal(wrapped[0].json.rotationIndex, 0);
  assert.equal(wrapped[0].json.workflowId, first[0].json.workflowId);
});

test('round-robin state is keyed off the same static data object across calls, not reset each time', () => {
  const code = nodeById.get('orchestrator-pick-next-topic').parameters.jsCode;
  const storeA = {};
  const storeB = {};
  const run = (store) => new Function('$getWorkflowStaticData', code)(() => store);

  run(storeA);
  run(storeA);
  const thirdOnA = run(storeA);
  assert.equal(thirdOnA[0].json.rotationIndex, 2, 'storeA should have advanced independently');

  const firstOnB = run(storeB);
  assert.equal(firstOnB[0].json.rotationIndex, 0, 'a fresh static data object must start the rotation over, not inherit storeA\'s position');
});

test('the dispatch node fires the selected sub-workflow without blocking on its completion', () => {
  const dispatch = nodeById.get('orchestrator-dispatch');
  assert.equal(dispatch.type, 'n8n-nodes-base.executeWorkflow');
  assert.equal(dispatch.parameters.source, 'database');
  assert.equal(dispatch.parameters.workflowId, '={{$json.workflowId}}');
  assert.equal(dispatch.parameters.options.waitForSubWorkflow, false, 'the orchestrator should dispatch and return immediately, not sit running for the sub-workflow\'s full render+publish duration');
});

test('both triggers feed the picker, and the picker feeds the dispatcher', () => {
  assert.equal(workflow.connections['Dispatch Four Times Daily'].main[0][0].node, 'Pick Next Topic Worker');
  assert.equal(workflow.connections['Run Orchestrator from Dashboard'].main[0][0].node, 'Pick Next Topic Worker');
  assert.equal(workflow.connections['Pick Next Topic Worker'].main[0][0].node, 'Dispatch Selected Topic Worker');
});
