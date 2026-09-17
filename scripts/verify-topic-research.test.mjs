import assert from 'node:assert/strict';
import test from 'node:test';
import { guardedFetch, runShadowVerification } from './verify-topic-research.mjs';
import { TOPIC_SLUGS, TOPIC_FORMATS } from '../renderer/src/research-topic-registry.mjs';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function readyResult(slug, format, overrides = {}) {
  return {
    status: 'ready', topicSlug: slug, format,
    sources: [{ source_url: 'https://example.com/docs', source_type: 'official-docs' }],
    diagnostics: { queryCount: 4, rawCount: 10, dedupedCount: 8, qualifiedCount: 5, primaryCount: 1 },
    topic: { slug, displayName: 'x', scope: 'y', excludeTerms: [] },
    ...overrides,
  };
}

function noResultResult(slug, format) {
  return {
    status: 'no_in_scope_research', topicSlug: slug, format, sources: [],
    diagnostics: { queryCount: 4, rawCount: 10, dedupedCount: 8, qualifiedCount: 2, primaryCount: 0 },
    reason: 'shortage',
    topic: { slug, displayName: 'x', scope: 'y', excludeTerms: [] },
  };
}

test('all ten combinations are exercised exactly once', async () => {
  const fetchImpl = async (url) => jsonResponse(200, noResultResult(new URL(url).searchParams.get('topicSlug') ?? 'x', 'tips'));
  // Actual body carries topicSlug/format, not query params -- read it back out for a realistic fake.
  const fake = async (url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse(200, noResultResult(body.topicSlug, body.format));
  };
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl: fake });
  assert.equal(report.combinations.length, 10);
  const seen = new Set(report.combinations.map((c) => `${c.topicSlug}:${c.format}`));
  for (const slug of TOPIC_SLUGS) for (const format of TOPIC_FORMATS) assert.ok(seen.has(`${slug}:${format}`), `missing ${slug}:${format}`);
});

test('a clean no_in_scope_research outcome is reported as passing, not failing', async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse(200, noResultResult(body.topicSlug, body.format));
  };
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl });
  assert.equal(report.allPassed, true);
  assert.ok(report.combinations.every((c) => c.ok && c.outcome === 'no_in_scope_research'));
});

test('a ready outcome with a primary source and valid fixture research passes', async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/v1/research/sources')) return jsonResponse(200, readyResult(body.topicSlug, body.format));
    if (pathname.endsWith('/v1/research/validate')) return jsonResponse(200, { valid: true, research: { recommended_topic: {} }, diagnostics: {} });
    throw new Error(`unexpected path ${pathname}`);
  };
  const fixtures = Object.fromEntries(TOPIC_SLUGS.flatMap((slug) => TOPIC_FORMATS.map((format) => [`${slug}:${format}`, { recommended_topic: {}, candidates: [] }])));
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl, fixtures });
  assert.equal(report.allPassed, true);
});

test('excess source count fails the acceptance check', async () => {
  const tooMany = Array.from({ length: 25 }, (_, i) => ({ source_url: `https://example.com/${i}`, source_type: 'official-docs' }));
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse(200, readyResult(body.topicSlug, body.format, { sources: tooMany }));
  };
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl });
  assert.equal(report.allPassed, false);
  assert.ok(report.combinations.every((c) => c.reasons.some((r) => r.includes('20-source cap'))));
});

test('a ready outcome with zero primary sources fails the acceptance check', async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse(200, readyResult(body.topicSlug, body.format, { diagnostics: { queryCount: 4, rawCount: 10, dedupedCount: 8, qualifiedCount: 5, primaryCount: 0 } }));
  };
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl });
  assert.equal(report.allPassed, false);
  assert.ok(report.combinations.every((c) => c.reasons.some((r) => r.includes('no primary/official source'))));
});

test('an unexpected recommendation/candidate mismatch surfaces as a validation failure, not a silent pass', async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/v1/research/sources')) return jsonResponse(200, readyResult(body.topicSlug, body.format));
    if (pathname.endsWith('/v1/research/validate')) return jsonResponse(422, { valid: false, failureCode: 'RECOMMENDATION_ORDER_MISMATCH', reasons: ['recommended_topic is not candidates[0]'] });
    throw new Error(`unexpected path ${pathname}`);
  };
  const fixtures = { 'agentic-ai:tips': { recommended_topic: { tool_name: 'B' }, candidates: [{ tool_name: 'A' }] } };
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl, fixtures });
  const target = report.combinations.find((c) => c.topicSlug === 'agentic-ai' && c.format === 'tips');
  assert.equal(target.validation.valid, false);
  assert.equal(target.validation.failureCode, 'RECOMMENDATION_ORDER_MISMATCH');
});

test('never calls dialogue, visuals, TTS, render, topic-history, or publishing endpoints', async () => {
  const called = [];
  const fetchImpl = async (url, options) => {
    called.push(new URL(url).pathname);
    const body = JSON.parse(options.body);
    return jsonResponse(200, readyResult(body.topicSlug, body.format));
  };
  await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl });
  assert.ok(called.every((p) => p.endsWith('/v1/research/sources')));
  assert.ok(!called.some((p) => /\/v1\/(render|visuals|publish|topic-history)/.test(p)));
});

test('guardedFetch refuses any URL outside the fixed research-only allowlist', async () => {
  let calledReal = false;
  const guarded = guardedFetch(async () => { calledReal = true; return jsonResponse(200, {}); });
  for (const forbidden of ['/v1/render', '/v1/visuals', '/v1/publish/instagram', '/v1/publish/youtube', '/v1/topic-history']) {
    await assert.rejects(() => guarded(new URL(forbidden, 'http://renderer.test')), /SHADOW_VERIFIER_FORBIDDEN_CALL/);
  }
  assert.equal(calledReal, false, 'the underlying fetch must never run for a forbidden path');
  await guarded(new URL('/v1/research/sources', 'http://renderer.test'), { method: 'POST' });
  assert.equal(calledReal, true, 'an allowed path must still reach the underlying fetch');
});

test('an infrastructure error on retrieval is reported as a failed combination, not silently skipped', async () => {
  const fetchImpl = async () => jsonResponse(502, { error: 'SEARXNG_HTTP_ERROR:503' });
  const report = await runShadowVerification({ baseUrl: 'http://renderer.test', fetchImpl });
  assert.equal(report.allPassed, false);
  assert.ok(report.combinations.every((c) => c.reasons.some((r) => r.includes('HTTP 502'))));
});
