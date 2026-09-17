import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readResearchCache, researchCachePath, writeResearchCache } from './research-cache.mjs';

async function tempMedia() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'research-cache-'));
}

test('researchCachePath keys by topic, format, and UTC date', async () => {
  const mediaDir = await tempMedia();
  const file = researchCachePath({
    topicSlug: 'editor-ide',
    format: 'tips',
    now: new Date('2026-09-17T03:15:00.000Z'),
    mediaDir,
  });
  assert.equal(file, path.join(mediaDir, 'research-cache', 'editor-ide-tips-2026-09-17.json'));
});

test('cache is fresh for twelve hours and expired afterwards', async () => {
  const mediaDir = await tempMedia();
  const now = new Date('2026-09-17T12:00:00.000Z');
  await writeResearchCache({ topicSlug: 'git-cli', format: 'trend', now, mediaDir }, {
    status: 'ready', sources: [{ source_url: 'https://git-scm.com' }],
  });
  assert.equal((await readResearchCache({ topicSlug: 'git-cli', format: 'trend', now: new Date('2026-09-17T23:59:59.000Z'), mediaDir })).status, 'ready');
  assert.equal(await readResearchCache({ topicSlug: 'git-cli', format: 'trend', now: new Date('2026-09-18T00:01:00.000Z'), mediaDir }), null);
});

test('corrupt JSON is recovered as a cache miss', async () => {
  const mediaDir = await tempMedia();
  const file = researchCachePath({ topicSlug: 'git-cli', format: 'tips', now: new Date('2026-09-17T00:00:00Z'), mediaDir });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{not-json', 'utf8');
  assert.equal(await readResearchCache({ topicSlug: 'git-cli', format: 'tips', now: new Date('2026-09-17T01:00:00Z'), mediaDir }), null);
});

test('writes atomically and strips authorization data from cached values', async () => {
  const mediaDir = await tempMedia();
  const now = new Date('2026-09-17T00:00:00Z');
  const file = await writeResearchCache({ topicSlug: 'agentic-ai', format: 'tips', now, mediaDir }, {
    status: 'ready', token: 'secret', authorization: 'Bearer secret',
    sources: [{ source_url: 'https://example.com', headers: { authorization: 'secret' } }],
  });
  assert.equal(file, researchCachePath({ topicSlug: 'agentic-ai', format: 'tips', now, mediaDir }));
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text.includes('secret'), false);
  assert.equal((await fs.readdir(path.dirname(file))).filter((entry) => entry.includes('.tmp')).length, 0);
});

test('cache files are isolated by topic and format', async () => {
  const mediaDir = await tempMedia();
  const now = new Date('2026-09-17T00:00:00Z');
  await writeResearchCache({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir }, { value: 'tips' });
  await writeResearchCache({ topicSlug: 'editor-ide', format: 'trend', now, mediaDir }, { value: 'trend' });
  await writeResearchCache({ topicSlug: 'git-cli', format: 'tips', now, mediaDir }, { value: 'git' });
  assert.equal((await readResearchCache({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir })).value, 'tips');
  assert.equal((await readResearchCache({ topicSlug: 'editor-ide', format: 'trend', now, mediaDir })).value, 'trend');
  assert.equal((await readResearchCache({ topicSlug: 'git-cli', format: 'tips', now, mediaDir })).value, 'git');
});
