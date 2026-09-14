import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isTopicUsed,
  readTopicHistory,
  recordTopic,
  selectUnusedTopic,
} from './topic-history.mjs';

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'topic-history-'));
  return path.join(dir, 'topic-history.json');
}

test('readTopicHistory returns an empty list when the file does not exist', async () => {
  const historyPath = await tempPath();
  assert.deepEqual(await readTopicHistory(historyPath), []);
});

test('recordTopic appends an entry and readTopicHistory returns it back', async () => {
  const historyPath = await tempPath();
  await recordTopic({tool_name: 'Agent Kit', category: 'Agent Harness', topic: 'Unified agent harness'}, historyPath);
  const history = await readTopicHistory(historyPath);
  assert.equal(history.length, 1);
  assert.equal(history[0].tool_name, 'Agent Kit');
  assert.equal(history[0].category, 'Agent Harness');
  assert.match(history[0].recommended_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('recordTopic permanently retains more than 20 completed topics', async () => {
  const historyPath = await tempPath();
  for (let i = 0; i < 25; i += 1) await recordTopic({tool_name: `Tool ${i}`, category: 'x', topic: `topic ${i}`}, historyPath);
  const history = await readTopicHistory(historyPath);
  assert.equal(history.length, 25);
  assert.equal(history[0].tool_name, 'Tool 0');
  assert.equal(history[24].tool_name, 'Tool 24');
});

test('isTopicUsed catches renamed versions of a previously rendered tool', () => {
  const history = [{
    tool_name: 'AI SDK Harness',
    category: 'Agent Harness',
    topic: 'AI SDK Harness gives agents a durable execution loop',
  }];

  assert.equal(isTopicUsed({
    tool_name: 'The AI-SDK Harness Layer',
    category: 'Developer Infrastructure',
    topic: 'A new execution layer for AI SDK Harness agents',
  }, history), true);
});

test('isTopicUsed allows a genuinely different tool and topic', () => {
  const history = [{
    tool_name: 'AI SDK Harness',
    category: 'Agent Harness',
    topic: 'AI SDK Harness gives agents a durable execution loop',
  }];

  assert.equal(isTopicUsed({
    tool_name: 'PostgreSQL',
    category: 'Databases',
    topic: 'PostgreSQL adds asynchronous I/O support',
  }, history), false);
});

test('selectUnusedTopic skips a repeated recommendation and promotes the first unused complete candidate', () => {
  const repeated = {
    tool_name: 'AI SDK Harness',
    category: 'Agent Harness',
    topic: 'AI SDK Harness gives agents a durable execution loop',
    claims: [{statement: 'Repeated'}],
    seo_brief: {primary_keyword: 'ai sdk harness'},
  };
  const unused = {
    tool_name: 'PostgreSQL',
    category: 'Databases',
    topic: 'PostgreSQL adds asynchronous I/O support',
    claims: [{statement: 'Fresh'}],
    seo_brief: {primary_keyword: 'postgres async io'},
  };
  const research = {recommended_topic: repeated, candidates: [repeated, unused]};

  const selected = selectUnusedTopic(research, [repeated]);

  assert.deepEqual(selected.recommended_topic, unused);
});

test('selectUnusedTopic refuses to continue when every researched candidate was already rendered', () => {
  const used = {
    tool_name: 'AI SDK Harness',
    category: 'Agent Harness',
    topic: 'AI SDK Harness gives agents a durable execution loop',
    claims: [{statement: 'Repeated'}],
    seo_brief: {primary_keyword: 'ai sdk harness'},
  };

  assert.throws(
    () => selectUnusedTopic({recommended_topic: used, candidates: [used]}, [used]),
    /TOPIC_HISTORY_ALL_CANDIDATES_USED/,
  );
});

test('selectUnusedTopic never promotes an incomplete candidate that cannot support a factual video', () => {
  const used = {
    tool_name: 'AI SDK Harness',
    topic: 'AI SDK Harness execution loop',
    claims: [{statement: 'Repeated'}],
  };
  const incomplete = {tool_name: 'PostgreSQL', topic: 'PostgreSQL asynchronous I/O'};

  assert.throws(
    () => selectUnusedTopic({recommended_topic: used, candidates: [incomplete]}, [used]),
    /TOPIC_HISTORY_ALL_CANDIDATES_USED/,
  );
});

test('readTopicHistory refuses to forget history when its storage is corrupt', async () => {
  const historyPath = await tempPath();
  await fs.writeFile(historyPath, 'not json');
  await assert.rejects(() => readTopicHistory(historyPath), /TOPIC_HISTORY_INVALID/);
});

test('recordTopic requires a tool_name', async () => {
  const historyPath = await tempPath();
  await assert.rejects(() => recordTopic({category: 'x', topic: 'y'}, historyPath), /TOPIC_HISTORY_TOOL_NAME_REQUIRED/);
});

test('recordTopic refuses to append a duplicate topic', async () => {
  const historyPath = await tempPath();
  await recordTopic({tool_name: 'AI SDK Harness', category: 'Agents', topic: 'Durable agent execution'}, historyPath);

  await assert.rejects(
    () => recordTopic({tool_name: 'The AI SDK Harness Layer', category: 'Infrastructure', topic: 'Agent execution layer'}, historyPath),
    /TOPIC_HISTORY_DUPLICATE/,
  );
  assert.equal((await readTopicHistory(historyPath)).length, 1);
});
