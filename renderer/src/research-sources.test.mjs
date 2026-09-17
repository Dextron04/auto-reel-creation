import test from 'node:test';
import assert from 'node:assert/strict';
import { getResearchTopic } from './research-topic-registry.mjs';
import {
  buildResearchQueries,
  canonicalizeResearchUrl,
  filterResearchSources,
  normalizeResearchResult,
  retrieveResearchSources,
  scoreResearchSource,
} from './research-sources.mjs';

const topic = getResearchTopic('editor-ide');
const now = new Date('2026-09-17T12:00:00Z');

function raw(url, title, content = title) {
  return { url, title, content, publishedDate: '2026-09-16T12:00:00Z' };
}

function fetchFor(resultsByQuery) {
  return async (url) => {
    const query = new URL(url).searchParams.get('q');
    return { ok: true, status: 200, async json() { return { results: resultsByQuery.get(query) ?? [] }; } };
  };
}

test('query packs differ by format', () => {
  assert.notDeepEqual(buildResearchQueries(topic, 'tips', false), buildResearchQueries(topic, 'trend', false));
  assert.notDeepEqual(buildResearchQueries(topic, 'tips', false), buildResearchQueries(topic, 'tips', true));
});

test('canonicalizes tracking parameters and fragments', () => {
  assert.equal(canonicalizeResearchUrl('HTTPS://Code.VisualStudio.com/docs?a=1&utm_source=x&fbclid=z#install'), 'https://code.visualstudio.com/docs?a=1');
});

test('canonicalization strips userinfo and sensitive query parameters', () => {
  assert.equal(canonicalizeResearchUrl('https://user:pass@example.com/docs?api_key=a&apikey=b&key=c&token=d&access_token=e&auth=f&authorization=g&secret=h&signature=i&safe=1'), 'https://example.com/docs?safe=1');
});

test('preferred domains receive an authority boost', () => {
  const preferred = normalizeResearchResult(raw('https://code.visualstudio.com/docs', 'VS Code editor feature'), { topic, format: 'tips', query: 'VS Code' , now });
  const community = normalizeResearchResult(raw('https://random.example/docs', 'VS Code editor feature'), { topic, format: 'tips', query: 'VS Code', now });
  assert.ok(scoreResearchSource(preferred, topic, 'tips', now).authority_score > scoreResearchSource(community, topic, 'tips', now).authority_score);
});

test('explicit exclusions reject an otherwise matching source', () => {
  const excluded = normalizeResearchResult(raw('https://code.visualstudio.com/docs', 'VS Code agent harness cloud deployment'), { topic, format: 'tips', query: 'VS Code', now });
  assert.equal(filterResearchSources([excluded], topic, 'tips', { now }).length, 0);
});

test('weak single-term tips remain borderline even on a preferred domain', () => {
  const databaseTopic = getResearchTopic('databases-performance');
  const launch = normalizeResearchResult(raw('https://postgresql.org/news/launch', 'PostgreSQL launches a new cloud dashboard'), { topic: databaseTopic, format: 'tips', query: 'PostgreSQL', now });
  assert.equal(filterResearchSources([launch], databaseTopic, 'tips', { now }).length, 0);
});

test('mixed-topic fixtures retain only the requested topic', () => {
  const rows = [
    normalizeResearchResult(raw('https://code.visualstudio.com/docs', 'VS Code refactoring feature'), { topic, format: 'tips', query: 'VS Code', now }),
    normalizeResearchResult(raw('https://platform.openai.com/docs/agents', 'AI agent tool calling'), { topic, format: 'tips', query: 'VS Code', now }),
  ];
  assert.deepEqual(filterResearchSources(rows, topic, 'tips', { now }).map((row) => row.source_url), ['https://code.visualstudio.com/docs']);
});

test('retrieval deduplicates URLs, caps sources at twenty, and returns diagnostics', async () => {
  const many = Array.from({ length: 25 }, (_, i) => raw(`https://code.visualstudio.com/docs/${i}?utm_source=test`, `VS Code feature ${i}`));
  many.push(raw('https://code.visualstudio.com/docs/0#top', 'duplicate')); 
  const query = topic.tipsQueries[0];
  const result = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-no-cache-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl: fetchFor(new Map([[query, many]])) });
  assert.equal(result.status, 'ready');
  assert.equal(result.sources.length, 10);
  assert.equal(result.diagnostics.dedupedCount, 10);
  assert.equal(result.diagnostics.queryCount, topic.tipsQueries.length);
});

test('one expanded query pass runs when the first pass is short', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get('q');
    seen.push(query);
    return { ok: true, async json() { return { results: [raw(`https://code.visualstudio.com/docs/${seen.length}`, `VS Code feature ${seen.length}`)] }; } };
  };
  const result = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-expanded-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl });
  assert.equal(result.status, 'ready');
  assert.equal(result.diagnostics.queryCount, topic.tipsQueries.length * 2);
  assert.equal(new Set(seen.slice(topic.tipsQueries.length)).size, topic.tipsQueries.length);
});

test('diagnostics count an expanded pass even when it returns no rows', async () => {
  const result = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-empty-expansion-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl: fetchFor(new Map()) });
  assert.equal(result.status, 'no_in_scope_research');
  assert.equal(result.diagnostics.queryCount, topic.tipsQueries.length * 2);
});

test('classifies borderline rows once and admits only confident in-scope rows', async () => {
  let calls = 0;
  const query = topic.tipsQueries[0];
  const results = [raw('https://code.visualstudio.com/docs/a', 'Editor productivity workflow'), raw('https://code.visualstudio.com/docs/b', 'Generic developer platform')];
  const result = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-classify-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl: fetchFor(new Map(topic.tipsQueries.map((q) => [q, q === query ? results : []]))), classifyBorderline: async (rows) => { calls += 1; return rows.map((row, i) => ({ in_scope: i === 0, confidence: i === 0 ? 0.95 : 0.99, reason: 'test' })); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'no_in_scope_research');
  assert.equal(result.diagnostics.qualifiedCount, 1);
});

test('shortage returns no_in_scope_research while infrastructure errors throw', async () => {
  const shortage = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-short-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl: fetchFor(new Map()) });
  assert.equal(shortage.status, 'no_in_scope_research');
  await assert.rejects(() => retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-missing-${process.pid}`, searxngUrl: '', fetchImpl: fetchFor(new Map()) }), /SEARXNG/);
  await assert.rejects(() => retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-http-${process.pid}`, searxngUrl: 'http://searxng.test', fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }) }), /SEARXNG/);
});
