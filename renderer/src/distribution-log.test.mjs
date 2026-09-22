import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readDistributionLog, recordDistributionEvent} from './distribution-log.mjs';

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'distribution-log-'));
  return path.join(dir, 'distribution-log.json');
}

test('readDistributionLog returns an empty list when the file does not exist', async () => {
  assert.deepEqual(await readDistributionLog(await tempPath()), []);
});

test('recordDistributionEvent appends a normalized entry and readDistributionLog returns it back', async () => {
  const logPath = await tempPath();
  await recordDistributionEvent({topicSlug: 'git-cli', format: 'tips', mediaId: '17895695668004550', permalink: 'https://instagram.com/p/abc'}, logPath);
  const log = await readDistributionLog(logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].topicSlug, 'git-cli');
  assert.equal(log[0].format, 'tips');
  assert.equal(log[0].mediaId, '17895695668004550');
  assert.equal(log[0].permalink, 'https://instagram.com/p/abc');
  assert.match(log[0].publishedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('recordDistributionEvent rejects an unknown topic or format', async () => {
  const logPath = await tempPath();
  await assert.rejects(() => recordDistributionEvent({topicSlug: 'not-real', format: 'tips', mediaId: '1'}, logPath), /DISTRIBUTION_LOG_UNKNOWN_TOPIC/);
  await assert.rejects(() => recordDistributionEvent({topicSlug: 'git-cli', format: 'not-real', mediaId: '1'}, logPath), /DISTRIBUTION_LOG_UNKNOWN_FORMAT/);
});

test('recordDistributionEvent rejects a missing mediaId', async () => {
  const logPath = await tempPath();
  await assert.rejects(() => recordDistributionEvent({topicSlug: 'git-cli', format: 'tips', mediaId: '   '}, logPath), /DISTRIBUTION_LOG_MEDIA_ID_REQUIRED/);
});

test('recordDistributionEvent appends across multiple calls, keeping publish order', async () => {
  const logPath = await tempPath();
  await recordDistributionEvent({topicSlug: 'git-cli', format: 'tips', mediaId: '1'}, logPath);
  await recordDistributionEvent({topicSlug: 'databases-performance', format: 'trend', mediaId: '2'}, logPath);
  const log = await readDistributionLog(logPath);
  assert.deepEqual(log.map((entry) => entry.mediaId), ['1', '2']);
});
