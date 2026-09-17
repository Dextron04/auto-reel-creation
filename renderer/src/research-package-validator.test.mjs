import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResearchPackage } from './research-package-validator.mjs';

const primaryByTopic = {
  'agentic-ai': ['MCP server', 'https://platform.openai.com/docs/agents', 'agent'],
  'editor-ide': ['VS Code', 'https://code.visualstudio.com/docs/editor/codebasics', 'editor'],
  'git-cli': ['git worktree', 'https://git-scm.com/docs/git-worktree', 'git'],
  'databases-performance': ['PostgreSQL EXPLAIN', 'https://www.postgresql.org/docs/current/using-explain.html', 'database'],
  'debugging-observability': ['OpenTelemetry tracing', 'https://opentelemetry.io/docs/concepts/signals/traces/', 'observability'],
};

function evidenceFor(slug, { recent = true } = {}) {
  const [, source_url, kind] = primaryByTopic[slug];
  return [{
    source_url: `${source_url}?utm_source=fixture#section`,
    title: `${kind} official guide`,
    summary: `Official ${kind} guide for developers.`,
    source_type: slug === 'git-cli' ? 'repository' : 'official-docs',
    published_at: recent ? '2026-09-12T00:00:00.000Z' : '2020-01-01T00:00:00.000Z',
  }];
}

function candidate(slug, overrides = {}) {
  const [name, source_url, kind] = primaryByTopic[slug];
  const base = {
    topic: `${name} developer workflow`,
    tool_name: name,
    category: kind,
    one_line_value: `A concrete ${kind} workflow improvement.`,
    developer_workflow: `Developers can use ${name} in the daily workflow.`,
    who_it_helps: 'Working software developers.',
    why_now: 'The current release documents this capability now.',
    hook: `${name} has a useful workflow most developers miss.`,
    why_it_matters: `It removes a concrete source of developer friction.`,
    visual_angle: 'Show the official documentation and workflow.',
    what_it_is: `Use ${name} to inspect the workflow.`,
    why_not_obvious: 'The option is buried in the official guide.',
    specific_action: `Run or use ${name} from the command line.`,
    concrete_payoff: 'It surfaces the exact problem before a change ships.',
    claims: [{ claim_id: 'c1', statement: `${name} supports this documented developer workflow.`, source_url }],
  };
  return { ...base, ...overrides };
}

function packageFor(slug, format = 'tips', overrides = {}) {
  const item = candidate(slug, format === 'trend' ? {
    ...candidate(slug),
    why_now: 'A release this week adds this documented capability.',
    developer_workflow: `Developers can use ${primaryByTopic[slug][0]} in production debugging workflow.`,
  } : {});
  return {
    recommended_topic: item,
    candidates: [item],
    ...overrides,
  };
}

for (const slug of Object.keys(primaryByTopic)) {
  test(`accepts a valid ${slug} candidate`, async () => {
    const research = packageFor(slug);
    const result = await validateResearchPackage({ topicSlug: slug, format: 'tips', evidence: evidenceFor(slug), research });
    assert.equal(result.valid, true);
    assert.strictEqual(result.research, research);
  });
}

test('canonicalizes claim URLs when checking evidence membership without rewriting research', async () => {
  const research = packageFor('editor-ide');
  const original = research.recommended_topic.claims[0].source_url;
  const result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'), research });
  assert.equal(result.valid, true);
  assert.equal(research.recommended_topic.claims[0].source_url, original);
});

test('accepts a valid Trend candidate with traceable recent evidence', async () => {
  const research = packageFor('git-cli', 'trend');
  const evidence = [{
    ...evidenceFor('git-cli')[0],
    title: 'Git worktree release update',
    summary: 'The Git worktree release update adds a documented workflow.',
  }];
  const result = await validateResearchPackage({ topicSlug: 'git-cli', format: 'trend', evidence, research });
  assert.equal(result.valid, true);
});

test('rejects a recommendation that is not candidates[0]', async () => {
  const first = candidate('git-cli');
  const second = candidate('git-cli', { tool_name: 'Git bisect' });
  const result = await validateResearchPackage({ topicSlug: 'git-cli', format: 'tips', evidence: evidenceFor('git-cli'), research: { recommended_topic: second, candidates: [first, second] } });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'RECOMMENDATION_ORDER');
});

test('rejects AI SDK Harness for Editor/IDE', async () => {
  const item = candidate('editor-ide', { topic: 'AI SDK Harness', tool_name: 'AI SDK Harness', category: 'agents', claims: [{ statement: 'An AI agent harness runs tools.', source_url: primaryByTopic['editor-ide'][1] }] });
  const result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'), research: { recommended_topic: item, candidates: [item] } });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'OFF_TOPIC_CANDIDATE');
});

test('rejects generic AI news for Git/CLI and Debugging/Observability', async () => {
  for (const slug of ['git-cli', 'debugging-observability']) {
    const item = candidate(slug, {
      topic: 'Generic AI news', tool_name: 'Generic AI launch', category: 'artificial intelligence',
      one_line_value: 'A generic model launch.', developer_workflow: 'No specific developer workflow.',
      who_it_helps: 'Everyone.', why_now: 'It was announced.', hook: 'Generic AI news.', why_it_matters: 'It is news.',
      visual_angle: 'A launch graphic.', what_it_is: 'A model launch.', specific_action: 'Read the announcement.',
      claims: [{ statement: 'A model launched.', source_url: primaryByTopic[slug][1] }],
    });
    const result = await validateResearchPackage({ topicSlug: slug, format: 'tips', evidence: evidenceFor(slug), research: { recommended_topic: item, candidates: [item] } });
    assert.equal(result.valid, false, slug);
    assert.equal(result.failureCode, 'OFF_TOPIC_CANDIDATE', slug);
  }
});

test('rejects database tips without a specific action or concrete payoff', async () => {
  const item = candidate('databases-performance', { what_it_is: 'Database performance', specific_action: '', concrete_payoff: 'Improves performance.' });
  const result = await validateResearchPackage({ topicSlug: 'databases-performance', format: 'tips', evidence: evidenceFor('databases-performance'), research: { recommended_topic: item, candidates: [item] } });
  assert.equal(result.valid, false);
  assert.ok(['TIP_ACTION_REQUIRED', 'TIP_PAYOFF_REQUIRED'].includes(result.failureCode));
});

test('rejects claims whose URLs are absent from evidence', async () => {
  const item = candidate('agentic-ai', { claims: [{ statement: 'Unsupported claim.', source_url: 'https://example.com/not-in-evidence' }] });
  const result = await validateResearchPackage({ topicSlug: 'agentic-ai', format: 'tips', evidence: evidenceFor('agentic-ai'), research: { recommended_topic: item, candidates: [item] } });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'UNSUPPORTED_CLAIM');
});

test('requires a primary source for the recommendation', async () => {
  const evidence = evidenceFor('editor-ide').map((row) => ({ ...row, source_type: 'article' }));
  const result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence, research: packageFor('editor-ide') });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'NO_PRIMARY_SOURCE');
});

test('rejects missing format-specific Tips and Trend fields', async () => {
  const tips = packageFor('editor-ide');
  delete tips.recommended_topic.concrete_payoff;
  let result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'), research: tips });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'MISSING_REQUIRED_FIELD');

  const missingTipsFields = packageFor('editor-ide');
  delete missingTipsFields.recommended_topic.one_line_value;
  delete missingTipsFields.recommended_topic.who_it_helps;
  result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'), research: missingTipsFields });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'MISSING_REQUIRED_FIELD');

  const trend = packageFor('git-cli', 'trend');
  delete trend.recommended_topic.why_now;
  result = await validateResearchPackage({ topicSlug: 'git-cli', format: 'trend', evidence: evidenceFor('git-cli'), research: trend });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'MISSING_REQUIRED_FIELD');
});

test('maps a valid empty result to NO_IN_SCOPE_RESEARCH, not invalid JSON', async () => {
  const result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence: [], research: { recommended_topic: null, candidates: [] } });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'NO_IN_SCOPE_RESEARCH');
  assert.equal(result.diagnostics.outcome, 'no_in_scope_research');
});

test('rejects malformed no-result statuses instead of treating them as an empty skip', async () => {
  const item = candidate('editor-ide');
  let result = await validateResearchPackage({
    topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'),
    research: { status: 'no_in_scope_research', recommended_topic: item, candidates: [item] },
  });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'INVALID_RESEARCH');
  assert.ok(result.reasons.includes('MALFORMED_NO_RESULT'));

  result = await validateResearchPackage({
    topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'),
    research: { status: 'no_in_scope_research', recommended_topic: null, candidates: {} },
  });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'INVALID_RESEARCH');
});

test('preserves primary authority when duplicate evidence URLs differ in source type', async () => {
  const research = packageFor('editor-ide');
  const row = evidenceFor('editor-ide')[0];
  const evidence = [
    { ...row, source_type: 'article' },
    { ...row, source_type: 'official-docs' },
  ];
  const result = await validateResearchPackage({ topicSlug: 'editor-ide', format: 'tips', evidence, research });
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.primaryEvidenceCount, 1);
});

test('suppresses classification for deterministic exclusions and unknown evidence URLs', async () => {
  let calls = 0;
  const excluded = candidate('editor-ide', { topic: 'AI SDK Harness', tool_name: 'AI SDK Harness', category: 'agents' });
  let result = await validateResearchPackage({
    topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'),
    research: { recommended_topic: excluded, candidates: [excluded] },
    classifyCandidate: async () => { calls += 1; return [{ in_scope: true, confidence: 1 }]; },
  });
  assert.equal(result.valid, false);
  assert.equal(calls, 0);

  const unknown = candidate('editor-ide', { claims: [{ statement: 'Unsupported.', source_url: 'https://unknown.example/item' }] });
  result = await validateResearchPackage({
    topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'),
    research: { recommended_topic: unknown, candidates: [unknown] },
    classifyCandidate: async () => { calls += 1; return [{ in_scope: true, confidence: 1 }]; },
  });
  assert.equal(result.valid, false);
  assert.equal(result.failureCode, 'UNSUPPORTED_CLAIM');
  assert.equal(calls, 0);
});

test('rejects vague Trend workflow and untraceable why-now boilerplate', async () => {
  const research = packageFor('git-cli', 'trend');
  research.recommended_topic.developer_workflow = 'Improves the developer workflow.';
  research.recommended_topic.why_now = 'This is important now for everyone.';
  const result = await validateResearchPackage({ topicSlug: 'git-cli', format: 'trend', evidence: evidenceFor('git-cli'), research });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('TREND_WORKFLOW_REQUIRED')));
  assert.ok(result.reasons.some((reason) => reason.startsWith('TREND_WHY_NOW_REQUIRED')));
});

test('uses the injected classifier only for ambiguous candidates', async () => {
  const item = candidate('editor-ide', {
    topic: 'An unusual code workspace', tool_name: 'Workspace feature', category: 'workflow',
    one_line_value: 'A useful workspace workflow.', developer_workflow: 'A developer workflow.',
    who_it_helps: 'Developers.', why_now: 'A current guide.', hook: 'A workspace trick.', why_it_matters: 'It removes friction.',
    visual_angle: 'A workflow screenshot.', what_it_is: 'Use the workspace feature.', why_not_obvious: 'Buried in docs.',
    specific_action: 'Use the workspace feature.', claims: [{ statement: 'The feature is documented.', source_url: primaryByTopic['editor-ide'][1] }],
  });
  let calls = 0;
  const result = await validateResearchPackage({
    topicSlug: 'editor-ide', format: 'tips', evidence: evidenceFor('editor-ide'),
    research: { recommended_topic: item, candidates: [item] },
    classifyCandidate: async (rows) => { calls += 1; assert.equal(rows.length, 1); return [{ in_scope: true, confidence: 0.9, reason: 'editor workflow' }]; },
  });
  assert.equal(calls, 1);
  assert.equal(result.valid, true);
});
