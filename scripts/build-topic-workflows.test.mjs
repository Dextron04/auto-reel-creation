import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildWrapperWorkflow, generateAll, WRAPPERS } from './build-topic-workflows.mjs';
import { TOPIC_SLUGS, TOPIC_FORMATS } from '../renderer/src/research-topic-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-topic-workflows.mjs');

test('the roster covers exactly ten wrappers, five per core, one per topic x format', () => {
  assert.equal(WRAPPERS.length, 10);
  const byFormat = { tips: 0, trend: 0 };
  for (const entry of WRAPPERS) byFormat[entry.format] += 1;
  assert.deepEqual(byFormat, { tips: 5, trend: 5 });
  for (const slug of TOPIC_SLUGS) for (const format of TOPIC_FORMATS) {
    assert.equal(WRAPPERS.filter((w) => w.slug === slug && w.format === format).length, 1, `expected exactly one wrapper for ${slug}:${format}`);
  }
});

test('buildWrapperWorkflow rejects an unknown slug or format before producing anything', () => {
  assert.throws(() => buildWrapperWorkflow({ slug: 'unknown-topic', format: 'tips', id: 'x', name: 'x', webhookPath: 'x', webhookId: 'x' }), /BUILD_TOPIC_WORKFLOWS_UNKNOWN_SLUG:unknown-topic/);
  assert.throws(() => buildWrapperWorkflow({ slug: 'editor-ide', format: 'weekly', id: 'x', name: 'x', webhookPath: 'x', webhookId: 'x' }), /BUILD_TOPIC_WORKFLOWS_UNKNOWN_FORMAT:weekly/);
});

test('generated wrappers preserve each entry\'s exact operational identifiers', () => {
  const files = generateAll();
  for (const entry of WRAPPERS) {
    const fileName = `topic-${entry.slug}-${entry.format}-reel.json`;
    const workflow = JSON.parse(files.get(fileName));
    assert.equal(workflow.id, entry.id);
    assert.equal(workflow.name, entry.name);
    const webhook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    assert.equal(webhook.parameters.path, entry.webhookPath);
    assert.equal(webhook.webhookId, entry.webhookId);
  }
});

test('generateAll is deterministic across repeated calls (required for a meaningful --check)', () => {
  const first = generateAll();
  const second = generateAll();
  assert.deepEqual([...first.entries()], [...second.entries()]);
});

test('no schedule trigger is ever generated into a wrapper', () => {
  const files = generateAll();
  for (const contents of files.values()) {
    const workflow = JSON.parse(contents);
    assert.ok(!workflow.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger'));
  }
});

test('--check exits zero when generated files match disk, matching the current committed state', () => {
  execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
});

test('--check exits nonzero and reports drift when a generated file is stale on disk', async () => {
  const target = path.join(ROOT, 'n8n', 'workflows', 'topic-agentic-ai-tips-reel.json');
  const original = await readFile(target, 'utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(target, original.replace('"active": true', '"active": false'));
  try {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }));
  } finally {
    await writeFile(target, original);
  }
});
