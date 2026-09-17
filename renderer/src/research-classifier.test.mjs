import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResearchItems } from './research-classifier.mjs';

const topic = Object.freeze({
  slug: 'editor-ide',
  scope: 'Code editor and IDE features, extensions, shortcuts, refactoring, navigation, debugging integration, and developer productivity settings.',
  includeTerms: ['MUST NOT APPEAR IN THE CLASSIFIER PROMPT'],
  excludeTerms: ['MUST NOT APPEAR IN THE CLASSIFIER PROMPT'],
});

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

function items() {
  return [
    { id: 'source-a', title: 'Refactoring workflow', summary: 'A practical IDE refactoring guide.', source_url: 'https://secret.example/a' },
    { id: 'source-b', title: 'Editor navigation', summary: 'Keyboard navigation details.' },
  ];
}

test('classifies one constrained batch with Anthropic and preserves input IDs/order', async () => {
  const calls = [];
  const result = await classifyResearchItems({
    topic,
    items: items(),
    kind: 'borderline-source',
    env: { ANTHROPIC_API_KEY: 'anthropic-test', ANTHROPIC_MODEL: 'claude-test' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ content: [{ type: 'text', text: JSON.stringify([
        { id: 'source-b', in_scope: false, confidence: 2, reason: 'not in scope' },
        { id: 'source-a', in_scope: true, confidence: -1, reason: 'editor evidence' },
        { id: 'invented', in_scope: true, confidence: 1, reason: 'must be ignored' },
      ]) }] });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, 'claude-test');
  assert.equal(calls[0].options.headers['x-api-key'], 'anthropic-test');
  assert.deepEqual(result, [
    { id: 'source-a', in_scope: true, confidence: 0, reason: 'editor evidence' },
    { id: 'source-b', in_scope: false, confidence: 1, reason: 'not in scope' },
  ]);
  assert.match(payload.messages[0].content, /Code editor and IDE features/);
  assert.match(payload.messages[0].content, /source-a/);
  assert.match(payload.messages[0].content, /Refactoring workflow/);
  assert.doesNotMatch(payload.messages[0].content, /MUST NOT APPEAR/);
  assert.doesNotMatch(payload.messages[0].content, /secret\.example/);
  assert.equal(Object.keys(result[0]).sort().join(','), 'confidence,id,in_scope,reason');
});

test('accepts fenced JSON and clamps malformed confidence values', async () => {
  const result = await classifyResearchItems({
    topic,
    items: [items()[0]],
    env: { ANTHROPIC_API_KEY: 'key' },
    fetchImpl: async () => response({ content: [{ type: 'text', text: '```json\n[{"id":"source-a","in_scope":true,"confidence": "not-a-number","reason":"ok"}]\n```' }] }),
  });
  assert.deepEqual(result, [{ id: 'source-a', in_scope: true, confidence: 0, reason: 'ok' }]);
});

test('uses local Qwen once when Anthropic is malformed and parses streamed JSON', async () => {
  const calls = [];
  const result = await classifyResearchItems({
    topic,
    items: [items()[0]],
    env: {
      ANTHROPIC_API_KEY: 'key',
      OLLAMA_CF_ACCESS_CLIENT_ID: 'client-id',
      OLLAMA_CF_ACCESS_CLIENT_SECRET: 'client-secret',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response({ content: [{ type: 'text', text: 'not json' }] });
      return response(`${JSON.stringify({ response: '[{"id":"source-a",' })}\n${JSON.stringify({ response: '"in_scope":true,"confidence":0.7,"reason":"qwen"}]' })}`);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://ollama.dextron04.in/api/generate');
  assert.equal(calls[1].options.headers['CF-Access-Client-Id'], 'client-id');
  assert.equal(calls[1].options.headers['CF-Access-Client-Secret'], 'client-secret');
  assert.deepEqual(result, [{ id: 'source-a', in_scope: true, confidence: 0.7, reason: 'qwen' }]);
});

test('falls back after Anthropic HTTP failure and returns safe decisions if fallback is unavailable', async () => {
  let calls = 0;
  const result = await classifyResearchItems({
    topic,
    items: items(),
    env: { ANTHROPIC_API_KEY: 'key', OLLAMA_CF_ACCESS_CLIENT_ID: 'id', OLLAMA_CF_ACCESS_CLIENT_SECRET: 'secret' },
    fetchImpl: async () => { calls += 1; return response({}, false, 503); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, [
    { id: 'source-a', in_scope: false, confidence: 0, reason: 'classifier unavailable' },
    { id: 'source-b', in_scope: false, confidence: 0, reason: 'classifier unavailable' },
  ]);
});

test('does not make a request for an empty batch', async () => {
  let calls = 0;
  assert.deepEqual(await classifyResearchItems({ topic, items: [], fetchImpl: async () => { calls += 1; } }), []);
  assert.equal(calls, 0);
});
