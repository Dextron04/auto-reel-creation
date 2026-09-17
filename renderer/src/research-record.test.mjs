import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeResearchRecord } from './research-record.mjs';

test('writes a complete redacted research record atomically', async () => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-record-'));
  const record = {
    topic: { slug: 'editor-ide', scope: 'editor features' },
    format: 'tips',
    diagnostics: { queryCount: 2, qualifiedCount: 1 },
    urls: ['https://code.visualstudio.com/docs'],
    decisions: [{ id: 'source-a', in_scope: true, confidence: 0.9 }],
    outcome: { status: 'ready', final: true },
    request: {
      authorization: 'Bearer very-secret',
      api_key: 'api-secret',
      nested: { accessToken: 'token-secret', clientSecret: 'secret-value', headers: { Cookie: 'private' } },
      safe: 'preserved',
    },
  };
  const target = await writeResearchRecord({ runId: 'run-2026-09-17_01', record, mediaDir });
  assert.equal(target, path.join(mediaDir, 'research-runs', 'run-2026-09-17_01.json'));
  const written = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(written.run_id, 'run-2026-09-17_01');
  assert.equal(written.topic.slug, 'editor-ide');
  assert.deepEqual(written.urls, record.urls);
  assert.deepEqual(written.decisions, record.decisions);
  assert.deepEqual(written.outcome, record.outcome);
  assert.equal(written.request.authorization, '[REDACTED]');
  assert.equal(written.request.api_key, '[REDACTED]');
  assert.equal(written.request.nested.accessToken, '[REDACTED]');
  assert.equal(written.request.nested.clientSecret, '[REDACTED]');
  assert.deepEqual(written.request.nested.headers, '[REDACTED]');
  assert.equal(written.request.safe, 'preserved');
  assert.deepEqual(await fs.readdir(path.join(mediaDir, 'research-runs')), ['run-2026-09-17_01.json']);
});

test('rejects unsafe run IDs before writing', async () => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-record-unsafe-'));
  for (const runId of ['../escape', 'nested/run', 'nested\\run', '', '.', '..', 'run\0id']) {
    await assert.rejects(() => writeResearchRecord({ runId, record: { topic: 'x' }, mediaDir }), /RESEARCH_RECORD_RUN_ID_INVALID/);
  }
});

test('requires a record and run ID', async () => {
  await assert.rejects(() => writeResearchRecord({ record: {} }), /RESEARCH_RECORD_REQUIRED/);
  await assert.rejects(() => writeResearchRecord({ runId: 'run-1' }), /RESEARCH_RECORD_REQUIRED/);
});
