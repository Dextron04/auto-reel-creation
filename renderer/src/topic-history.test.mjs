import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readTopicHistory, recordTopic} from './topic-history.mjs';

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

test('recordTopic keeps only the most recent 20 entries', async () => {
  const historyPath = await tempPath();
  for (let i = 0; i < 25; i += 1) await recordTopic({tool_name: `Tool ${i}`, category: 'x', topic: `topic ${i}`}, historyPath);
  const history = await readTopicHistory(historyPath);
  assert.equal(history.length, 20);
  assert.equal(history[0].tool_name, 'Tool 5');
  assert.equal(history[19].tool_name, 'Tool 24');
});

test('readTopicHistory tolerates a corrupt file by returning an empty list', async () => {
  const historyPath = await tempPath();
  await fs.writeFile(historyPath, 'not json');
  assert.deepEqual(await readTopicHistory(historyPath), []);
});

test('recordTopic requires a tool_name', async () => {
  const historyPath = await tempPath();
  await assert.rejects(() => recordTopic({category: 'x', topic: 'y'}, historyPath), /TOPIC_HISTORY_TOOL_NAME_REQUIRED/);
});
