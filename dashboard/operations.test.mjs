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
