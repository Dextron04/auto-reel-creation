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
  assert.equal(canonicalizeResearchUrl('https://user:pass@example.com/docs?api_key=a&apikey=b&key=c&token=d&access_token=e&refresh_token=r&auth=f&auth_token=at&authorization=g&authorisation=au&secret=h&client_secret=cs&password=p&passwd=pw&signature=i&sig=sg&credential=cr&session_id=sid&safe=1'), 'https://example.com/docs?safe=1');
});

test('preferred domains receive an authority boost', () => {
  const preferred = normalizeResearchResult(raw('https://code.visualstudio.com/docs', 'VS Code editor feature'), { topic, format: 'tips', query: 'VS Code' , now });
  const community = normalizeResearchResult(raw('https://random.example/docs', 'VS Code editor feature'), { topic, format: 'tips', query: 'VS Code', now });
  assert.ok(scoreResearchSource(preferred, topic, 'tips', now).authority_score > scoreResearchSource(community, topic, 'tips', now).authority_score);
});

// A live production run against 12 real SearXNG results found zero with a usable published_at
// from any raw field, even for official changelog/release-notes pages that plainly embed a date
// in their own URL -- which made the Trend format's recency check (research-package-validator.mjs
// isRecent()) structurally unsatisfiable regardless of content quality. This locks in the fix.
test('normalizeResearchResult falls back to a date embedded in the URL when no other date field is present', () => {
  const cases = [
    ['https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate', '2026-07-28T00:00:00.000Z'],
    ['https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary', '2025-11-25T00:00:00.000Z'],
    ['https://azure.github.io/azure-sdk/releases/2026-03/dotnet.html', '2026-03-01T00:00:00.000Z'],
  ];
  for (const [url, expected] of cases) {
    // Matches the real SearXNG "general" category result shape: no publishedDate/published/date
    // field at all, which is exactly what a live run found for every one of 12 real results.
    const result = normalizeResearchResult({ url, title: 'Release notes' }, { topic, format: 'trend', query: 'x', now });
    assert.equal(result.published_at, expected, url);
  }
});

test('the URL-date fallback never overrides a real date field, and ignores non-date-shaped URLs', () => {
  const withRealDate = normalizeResearchResult({ url: 'https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate', title: 'x', publishedDate: '2020-01-01T00:00:00.000Z' }, { topic, format: 'trend', query: 'x', now });
  assert.equal(withRealDate.published_at, '2020-01-01T00:00:00.000Z', 'a real date field must win over a URL-embedded guess');

  const noDateShape = normalizeResearchResult({ url: 'https://github.com/microsoft/agent-framework/releases', title: 'Releases' }, { topic, format: 'trend', query: 'x', now });
  assert.equal(noDateShape.published_at, null, 'a URL with no embedded date must stay null, not be invented');

  // A version-number-shaped path segment (v2/04, or a bare port-looking number) must not be
  // misread as a year -- the regex requires a 4-digit year followed by a plausible month.
  const versionLike = normalizeResearchResult({ url: 'https://example.com/docs/v2/04/setup', title: 'Setup guide' }, { topic, format: 'trend', query: 'x', now });
  assert.equal(versionLike.published_at, null, 'a non-date path must not be misread as a date');
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

test('weak single-term rows are sent to the classifier', async () => {
  let calls = 0;
  const databaseTopic = getResearchTopic('databases-performance');
  const query = databaseTopic.tipsQueries[0];
  const result = await retrieveResearchSources({
    topicSlug: 'databases-performance',
    format: 'tips',
    now,
    mediaDir: `/tmp/research-test-weak-classifier-${process.pid}-${Date.now()}`,
    searxngUrl: 'http://searxng.test',
    fetchImpl: fetchFor(new Map(databaseTopic.tipsQueries.map((item) => [item, item === query ? [raw('https://postgresql.org/news/launch', 'PostgreSQL launches a new cloud dashboard')] : []]))),
    classifyBorderline: async (rows) => { calls += 1; return rows.map(() => ({ in_scope: true, confidence: 0.9, reason: 'database launch is in scope' })); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'no_in_scope_research');
  assert.equal(result.diagnostics.qualifiedCount, 1);
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

// n8n's two shared core workflows (one Tips core, one Trend core) serve all five topics from a
// single workflow definition and cannot import research-topic-registry.mjs directly, so both
// outcomes must carry enough registry-sourced policy for a core to build a topic-scoped prompt
// and judge at runtime without hand-duplicating scope text into workflow JSON.
test('both outcomes carry a registry-sourced topic descriptor for topic-agnostic n8n cores', async () => {
  const many = Array.from({ length: 6 }, (_, i) => raw(`https://code.visualstudio.com/docs/descriptor-${i}`, `VS Code feature ${i}`));
  const ready = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-descriptor-ready-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl: fetchFor(new Map([[topic.tipsQueries[0], many]])) });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.topic, { slug: 'editor-ide', displayName: topic.displayName, scope: topic.scope, excludeTerms: topic.excludeTerms });

  const shortage = await retrieveResearchSources({ topicSlug: 'editor-ide', format: 'tips', now, mediaDir: `/tmp/research-test-descriptor-shortage-${process.pid}-${Date.now()}`, searxngUrl: 'http://searxng.test', fetchImpl: fetchFor(new Map()) });
  assert.equal(shortage.status, 'no_in_scope_research');
  assert.deepEqual(shortage.topic, { slug: 'editor-ide', displayName: topic.displayName, scope: topic.scope, excludeTerms: topic.excludeTerms });
});
