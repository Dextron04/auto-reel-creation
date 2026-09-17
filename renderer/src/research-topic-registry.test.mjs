import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPIC_FORMATS,
  TOPIC_SLUGS,
  getResearchTopic,
  validateTopicRegistry,
} from './research-topic-registry.mjs';

const EXPECTED_SLUGS = [
  'agentic-ai',
  'editor-ide',
  'git-cli',
  'databases-performance',
  'debugging-observability',
];

test('exposes the canonical topic slugs and formats', () => {
  assert.deepEqual(TOPIC_SLUGS, EXPECTED_SLUGS);
  assert.deepEqual(TOPIC_FORMATS, ['tips', 'trend']);
  assert.equal(new Set(TOPIC_SLUGS).size, TOPIC_SLUGS.length);
});

test('returns deeply frozen, actionable policy entries for every topic', () => {
  for (const slug of EXPECTED_SLUGS) {
    const topic = getResearchTopic(slug);
    assert.equal(Object.isFrozen(topic), true);
    for (const field of ['includeTerms', 'excludeTerms', 'preferredDomains', 'tipsQueries', 'trendQueries']) {
      assert.equal(Array.isArray(topic[field]), true, `${slug}.${field} should be an array`);
      assert.equal(topic[field].length > 0, true, `${slug}.${field} should not be empty`);
      assert.equal(Object.isFrozen(topic[field]), true, `${slug}.${field} should be frozen`);
    }
    assert.equal(typeof topic.scope, 'string');
    assert.equal(topic.scope.length > 0, true);
    assert.equal(Number.isInteger(topic.minimumQualifiedSources), true);
    assert.equal(topic.minimumQualifiedSources > 0, true);
    assert.equal(Number.isInteger(topic.minimumPrimarySources), true);
    assert.equal(topic.minimumPrimarySources > 0, true);
    assert.equal(topic.minimumPrimarySources <= topic.minimumQualifiedSources, true);
  }
});

test('routes representative sources and vocabulary to the right topic', () => {
  assert.ok(getResearchTopic('editor-ide').preferredDomains.includes('code.visualstudio.com'));
  assert.ok(getResearchTopic('git-cli').preferredDomains.includes('git-scm.com'));
  assert.ok(getResearchTopic('databases-performance').preferredDomains.includes('postgresql.org'));
  assert.ok(getResearchTopic('debugging-observability').preferredDomains.includes('opentelemetry.io'));
  assert.ok(getResearchTopic('agentic-ai').includeTerms.includes('model context protocol'));
});

test('rejects unknown topic slugs with a stable error', () => {
  assert.throws(() => getResearchTopic('not-a-topic'), {
    message: 'RESEARCH_TOPIC_UNKNOWN:not-a-topic',
  });
});

test('validates a registry and reports malformed policy data', () => {
  assert.equal(validateTopicRegistry({
    'example-topic': {
      slug: 'example-topic',
      displayName: 'Example',
      scope: 'example scope',
      includeTerms: ['example'],
      excludeTerms: ['unrelated'],
      preferredDomains: ['example.com'],
      tipsQueries: ['example tip'],
      trendQueries: ['example trend'],
      minimumQualifiedSources: 2,
      minimumPrimarySources: 1,
    },
  }), true);
  assert.throws(() => validateTopicRegistry({}), /RESEARCH_TOPIC_REGISTRY_INVALID/);
});
