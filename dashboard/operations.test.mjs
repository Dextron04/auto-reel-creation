import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executionListPath,
  formatScheduledRun,
  manualRunAvailability,
  triggerManualRun,
  mapExecution,
  mergeExecutionDetails,
  nextCronOccurrence,
  workflowTopology,
} from './operations.mjs';

test('manualRunAvailability blocks a duplicate while an execution is running', () => {
  assert.deepEqual(
    manualRunAvailability([
      {id: '1843', status: 'success'},
      {id: '1844', status: 'running'},
    ]),
    {
      allowed: false,
      runningExecutionId: '1844',
      message: 'Execution #1844 is already running.',
    },
  );
});

test('manualRunAvailability allows a run when no execution is active', () => {
  assert.deepEqual(
    manualRunAvailability([
      {id: '1843', status: 'success'},
      {id: '1842', status: 'error'},
    ]),
    {allowed: true, runningExecutionId: null, message: null},
  );
});

test('triggerManualRun refuses to invoke n8n for a duplicate execution', async () => {
  let invoked = false;
  const result = await triggerManualRun(
    [{id: '1844', status: 'running'}],
    async () => { invoked = true; },
  );

  assert.equal(invoked, false);
  assert.deepEqual(result, {
    accepted: false,
    runningExecutionId: '1844',
    message: 'Execution #1844 is already running.',
  });
});

test('triggerManualRun invokes n8n when the workflow is idle', async () => {
  let invoked = false;
  const result = await triggerManualRun([], async () => { invoked = true; });

  assert.equal(invoked, true);
  assert.deepEqual(result, {accepted: true, runningExecutionId: null, message: 'Workflow started.'});
});

test('nextCronOccurrence finds the next twice-daily run in the configured timezone', () => {
  const next = nextCronOccurrence(
    '0 9,17 * * *',
    new Date('2026-09-14T15:00:00.000Z'),
    'America/Chicago',
  );

  assert.equal(next?.toISOString(), '2026-09-14T22:00:00.000Z');
});

test('nextCronOccurrence honors stepped hour expressions', () => {
  const next = nextCronOccurrence(
    '0 */6 * * *',
    new Date('2026-09-14T15:01:00.000Z'),
    'America/Chicago',
  );

  assert.equal(next?.toISOString(), '2026-09-14T17:00:00.000Z');
});

test('formatScheduledRun labels a summer Chicago time as CDT', () => {
  const label = formatScheduledRun(
    new Date('2026-09-14T22:00:00.000Z'),
    'America/Chicago',
  );

  assert.equal(label, 'Mon, 5:00 PM CDT');
});

test('executionListPath requests lightweight paginated summaries', () => {
  assert.equal(
    executionListPath('workflow 1', 'page 2'),
    '/api/v1/executions?workflowId=workflow+1&limit=50&cursor=page+2',
  );
});

test('mergeExecutionDetails enriches only matching execution summaries', () => {
  const merged = mergeExecutionDetails(
    [
      {id: '10', status: 'running', currentNodes: []},
      {id: '9', status: 'success', currentNodes: []},
    ],
    [{id: '10', status: 'running', currentNodes: ['Render reel']}],
  );

  assert.deepEqual(merged, [
    {id: '10', status: 'running', currentNodes: ['Render reel']},
    {id: '9', status: 'success', currentNodes: []},
  ]);
});

test('mapExecution exposes every node currently on the execution stack', () => {
  const mapped = mapExecution({
    id: '1842',
    status: 'running',
    mode: 'trigger',
    startedAt: '2026-09-14T20:00:00.000Z',
    stoppedAt: null,
    data: {
      resultData: {lastNodeExecuted: 'Merge Research Sources'},
      executionData: {
        nodeExecutionStack: [
          {node: {name: 'Fetch OpenAI News'}},
          {node: {name: 'Fetch Google AI News'}},
          {node: {name: 'Fetch OpenAI News'}},
        ],
      },
    },
  });

  assert.deepEqual(mapped.currentNodes, ['Fetch OpenAI News', 'Fetch Google AI News']);
  assert.equal(mapped.lastNode, 'Merge Research Sources');
  assert.equal(mapped.error, null);
});

test('mapExecution reports the failed node and nested error message', () => {
  const mapped = mapExecution({
    id: '1841',
    status: 'error',
    mode: 'trigger',
    startedAt: '2026-09-14T19:00:00.000Z',
    stoppedAt: '2026-09-14T19:01:00.000Z',
    data: {
      resultData: {
        lastNodeExecuted: 'Render 9:16 Reel with Subtitles',
        error: {message: 'Renderer timed out'},
      },
    },
  });

  assert.equal(mapped.lastNode, 'Render 9:16 Reel with Subtitles');
  assert.equal(mapped.error, 'Renderer timed out');
  assert.deepEqual(mapped.currentNodes, []);
});

test('workflowTopology returns a stable dependency order with operational stages', () => {
  const topology = workflowTopology({
    nodes: [
      {name: 'Publish to Instagram', type: 'http', position: [500, 0]},
      {name: 'Run from Dashboard', type: 'webhook', position: [0, 0]},
      {name: 'Render 9:16 Reel with Subtitles', type: 'http', position: [300, 0]},
      {name: 'Generate Dialogue Turn WAV', type: 'http', position: [200, 0]},
    ],
    connections: {
      'Run from Dashboard': {main: [[{node: 'Generate Dialogue Turn WAV'}]]},
      'Generate Dialogue Turn WAV': {main: [[{node: 'Render 9:16 Reel with Subtitles'}]]},
      'Render 9:16 Reel with Subtitles': {main: [[{node: 'Publish to Instagram'}]]},
    },
  });

  assert.deepEqual(topology.map(node => node.name), [
    'Run from Dashboard',
    'Generate Dialogue Turn WAV',
    'Render 9:16 Reel with Subtitles',
    'Publish to Instagram',
  ]);
  assert.deepEqual(topology.map(node => node.stage), ['discover', 'voice', 'render', 'publish']);
});

test('mapExecution exposes completed, active, failed, and queued node states', () => {
  const workflowNodes = [
    {name: 'Fetch OpenAI News', stage: 'discover'},
    {name: 'Research with Claude', stage: 'script'},
    {name: 'Find and Download Script Images', stage: 'visuals'},
    {name: 'Validate Production Editorial Package', stage: 'quality'},
  ];
  const mapped = mapExecution({
    id: '2001',
    status: 'running',
    startedAt: '2026-09-15T12:00:00.000Z',
    data: {
      resultData: {
        runData: {
          'Fetch OpenAI News': [{startTime: 1, executionTime: 80}],
          'Research with Claude': [{startTime: 2, executionTime: 420}],
          'Find and Download Script Images': [{startTime: 3, executionTime: 120, error: {message: 'candidate unavailable'}}],
        },
      },
      executionData: {nodeExecutionStack: [{node: {name: 'Research with Claude'}}]},
    },
  }, workflowNodes);

  assert.deepEqual(mapped.nodeStates.map(node => [node.name, node.state]), [
    ['Fetch OpenAI News', 'complete'],
    ['Research with Claude', 'active'],
    ['Find and Download Script Images', 'failed'],
    ['Validate Production Editorial Package', 'queued'],
  ]);
  assert.equal(mapped.completedNodeCount, 1);
  assert.equal(mapped.totalNodeCount, 4);
  assert.equal(mapped.progressPercent, 25);
});
