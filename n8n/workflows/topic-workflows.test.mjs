import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { buildWrapperWorkflow, WRAPPERS } from '../../scripts/build-topic-workflows.mjs';
import { TOPIC_SLUGS, TOPIC_FORMATS } from '../../renderer/src/research-topic-registry.mjs';

const dir = new URL('.', import.meta.url);
const wrapperFiles = (await readdir(dir)).filter((name) => /^topic-.+-(tips|trend)-reel\.json$/.test(name));
assert.equal(wrapperFiles.length, 10, `expected 5 topics x 2 formats = 10 topic wrapper files, found ${wrapperFiles.length}: ${wrapperFiles.join(', ')}`);

const wrappers = await Promise.all(wrapperFiles.map(async (file) => {
  const slug = file.match(/^topic-(.+)-(tips|trend)-reel\.json$/)[1];
  const format = file.match(/^topic-(.+)-(tips|trend)-reel\.json$/)[2];
  const workflow = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
  return { file, slug, format, workflow };
}));

const cores = await Promise.all([
  ['topic-tips-core.json', 'tips'],
  ['topic-trend-core.json', 'trend'],
].map(async ([file, format]) => ({ file, format, workflow: JSON.parse(await readFile(new URL(file, dir), 'utf8')) })));

function outgoing(workflow, nodeName) {
  const targets = new Set();
  for (const branch of workflow.connections[nodeName]?.main ?? []) for (const t of branch) targets.add(t.node);
  return targets;
}

function incomingSources(workflow, nodeName) {
  const sources = [];
  for (const [from, def] of Object.entries(workflow.connections)) {
    for (const branch of def.main ?? []) for (const t of branch) if (t.node === nodeName) sources.push(from);
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Wrapper topology: every wrapper is a thin, topic-immutable shim over a shared core.
// ---------------------------------------------------------------------------

test('the wrapper roster covers every topic x format combination exactly once, with no unknown slug', () => {
  assert.equal(WRAPPERS.length, 10);
  for (const slug of TOPIC_SLUGS) for (const format of TOPIC_FORMATS) {
    assert.ok(WRAPPERS.some((w) => w.slug === slug && w.format === format), `missing wrapper for ${slug}:${format}`);
  }
  assert.throws(() => buildWrapperWorkflow({ slug: 'not-a-real-topic', format: 'tips' }), /BUILD_TOPIC_WORKFLOWS_UNKNOWN_SLUG/);
  assert.throws(() => buildWrapperWorkflow({ slug: 'editor-ide', format: 'not-a-real-format' }), /BUILD_TOPIC_WORKFLOWS_UNKNOWN_FORMAT/);
});

test('every generated wrapper file on disk matches the canonical generator output exactly', () => {
  for (const { file, slug, format, workflow } of wrappers) {
    const entry = WRAPPERS.find((w) => w.slug === slug && w.format === format);
    assert.ok(entry, `${file}: no roster entry for ${slug}:${format}`);
    assert.deepEqual(workflow, buildWrapperWorkflow(entry), `${file}: does not match scripts/build-topic-workflows.mjs`);
  }
});

test('every wrapper has a unique webhook path and a unique n8n-facing workflow name', () => {
  const paths = new Set();
  const names = new Set();
  const ids = new Set();
  for (const { file, workflow } of wrappers) {
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.webhook') {
        assert.ok(!paths.has(node.parameters.path), `${file}: duplicate webhook path ${node.parameters.path}`);
        paths.add(node.parameters.path);
      }
    }
    assert.ok(!names.has(workflow.name), `duplicate workflow name ${workflow.name}`);
    names.add(workflow.name);
    assert.ok(!ids.has(workflow.id), `duplicate workflow id ${workflow.id}`);
    ids.add(workflow.id);
  }
  assert.equal(paths.size, 10);
});

test('every wrapper is driven by the round-robin orchestrator, not its own schedule, and both triggers attach the immutable slug before calling a core', () => {
  for (const { file, slug, format, workflow } of wrappers) {
    const types = workflow.nodes.map((node) => node.type);
    assert.ok(types.includes('n8n-nodes-base.executeWorkflowTrigger'), `${file}: missing Execute Workflow Trigger entry point`);
    assert.ok(!types.includes('n8n-nodes-base.scheduleTrigger'), `${file}: must not have its own schedule -- the orchestrator owns scheduling`);

    const attach = workflow.nodes.find((n) => n.name === 'Attach Topic Slug');
    assert.ok(attach, `${file}: missing Attach Topic Slug node`);
    assert.match(attach.parameters.jsCode, new RegExp(`topicSlug:\\s*"${slug}"`), `${file}: Attach Topic Slug does not attach its own immutable slug`);

    const roundRobinTargets = outgoing(workflow, 'When Executed by Round Robin');
    const dashboardTriggerName = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').name;
    const dashboardTargets = outgoing(workflow, dashboardTriggerName);
    assert.deepEqual([...roundRobinTargets], ['Attach Topic Slug'], `${file}: round-robin trigger must go straight to Attach Topic Slug`);
    assert.deepEqual([...dashboardTargets], ['Attach Topic Slug'], `${file}: dashboard trigger must go straight to Attach Topic Slug`);

    const coreNode = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflow');
    assert.ok(coreNode, `${file}: missing Execute Workflow node calling a shared core`);
    assert.equal(coreNode.parameters.options?.waitForSubWorkflow, true, `${file}: core call must block for its result (waitForSubWorkflow)`);
    const expectedEnvVar = format === 'tips' ? 'TOPIC_TIPS_CORE_WORKFLOW_ID' : 'TOPIC_TREND_CORE_WORKFLOW_ID';
    assert.match(coreNode.parameters.workflowId, new RegExp(`\\$env\\.${expectedEnvVar}\\b`), `${file}: must invoke the ${format} core by its configured workflow id env var`);
    assert.deepEqual([...outgoing(workflow, 'Attach Topic Slug')], [coreNode.name], `${file}: Attach Topic Slug must call the core directly`);
  }
});

test('every wrapper is active so its dashboard webhook stays reachable', () => {
  for (const { file, workflow } of wrappers) assert.equal(workflow.active, true, `${file}: must remain active for its dashboard webhook to be registered`);
});

// ---------------------------------------------------------------------------
// Core pipelines: shared, topic-agnostic, retrieval-backed, fail-closed.
// ---------------------------------------------------------------------------

// A live n8n 2.38.7 instance refused to run a core via Execute Workflow with "Workflow is not
// active and cannot be executed." even though the core has no independent trigger of its own --
// n8n requires the invoked sub-workflow to be active regardless of invocation source.
test('both cores are marked active, or n8n refuses to invoke them via Execute Workflow', () => {
  for (const { file, workflow } of cores) assert.equal(workflow.active, true, `${file}: must be active for a live n8n instance to execute it as a sub-workflow`);
});

// A manual "Execute workflow" test directly on a core in the n8n editor (rather than through a
// wrapper) passes no input, so topicSlug was silently undefined and cascaded into a cryptic
// RESEARCH_TOPIC_UNKNOWN:undefined several nodes downstream -- this asserts the immediate,
// actionable guard exists and actually throws for that case.
test('both cores fail immediately with an actionable message when run without a wrapper-supplied topicSlug', () => {
  for (const { file, workflow } of cores) {
    const guard = workflow.nodes.find((n) => n.name === 'Guard Topic Slug Provided');
    assert.ok(guard, `${file}: missing the topicSlug presence guard`);
    assert.deepEqual(incomingSources(workflow, 'Guard Topic Slug Provided'), ['When Executed by Wrapper'], `${file}: guard must sit directly after the trigger`);
    const fn = new Function('$json', guard.parameters.jsCode);
    assert.throws(() => fn({}), /CORE_REQUIRES_TOPIC_SLUG/, `${file}: must reject a missing topicSlug immediately`);
    assert.doesNotThrow(() => fn({ topicSlug: 'git-cli' }), `${file}: must pass through a real topicSlug unchanged`);
  }
});

test('both cores exist exactly once, take only {topicSlug} as input, and are not self-scheduled', () => {
  assert.equal(cores.length, 2);
  for (const { file, workflow } of cores) {
    const trigger = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
    assert.ok(trigger, `${file}: missing Execute Workflow Trigger entry point`);
    assert.deepEqual(trigger.parameters, {}, `${file}: trigger must not declare a fixed input schema -- topicSlug arrives as caller-supplied data`);
    assert.ok(!workflow.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger'), `${file}: a shared core must never be independently scheduled`);
    assert.ok(!workflow.nodes.some((n) => n.type === 'n8n-nodes-base.webhook'), `${file}: a shared core must not expose its own dashboard webhook -- that belongs to the wrapper`);
  }
});

// Same historical bug classes the pre-consolidation suite guarded against, now checked against
// the two core files instead of ten near-duplicates.
test('every core: no dangling $items()/$() node references', () => {
  for (const { file, workflow } of cores) {
    const names = new Set(workflow.nodes.map((node) => node.name));
    const refPattern = /\$(?:items)?\('([^']+)'\)/g;
    for (const node of workflow.nodes) {
      const jsCode = node.parameters?.jsCode;
      if (!jsCode) continue;
      for (const match of jsCode.matchAll(refPattern)) {
        assert.ok(names.has(match[1]), `${file}: ${node.name} references missing node '${match[1]}'`);
      }
    }
  }
});

test('every core: neverError never sits at the flat options.neverError path', () => {
  for (const { file, workflow } of cores) {
    for (const node of workflow.nodes) {
      const options = node.parameters?.options;
      if (options && typeof options === 'object') {
        assert.equal(options.neverError, undefined, `${file}: ${node.name} has neverError at the flat (broken) path`);
      }
    }
  }
});

test('every core: every connection target and every $()/$items() reference resolves to a real node', () => {
  for (const { file, workflow } of cores) {
    const names = new Set(workflow.nodes.map((n) => n.name));
    for (const [from, def] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from), `${file}: connection source '${from}' is not a node`);
      for (const branch of def.main ?? []) for (const target of branch) {
        assert.ok(names.has(target.node), `${file}: connection target '${target.node}' (from '${from}') is not a node`);
      }
    }
  }
});

test('every core sources evidence from topic-specific retrieval, not a generic multi-feed fan-in', () => {
  for (const { file, workflow } of cores) {
    assert.ok(!workflow.nodes.some((n) => n.type === 'n8n-nodes-base.rssFeedRead'), `${file}: must not fetch generic RSS feeds directly -- retrieval is the renderer's job`);
    assert.ok(!workflow.nodes.some((n) => n.type === 'n8n-nodes-base.merge'), `${file}: must not merge generic feed sources -- that fan-in caused the audited off-topic incidents`);
    const fetchSources = workflow.nodes.find((n) => n.name === 'Fetch Topic-Specific Research Sources');
    assert.ok(fetchSources, `${file}: missing the topic-specific retrieval call`);
    assert.match(fetchSources.parameters.url, /\/v1\/research\/sources$/, `${file}: must call the renderer's research sources endpoint`);
    assert.match(fetchSources.parameters.jsonBody, new RegExp(`format:\\s*'${cores.find((c) => c.file === file).format}'`), `${file}: must request its own fixed format, not a caller-supplied one`);
  }
});

test('every core validates research before it can reach dialogue, with one bounded retry', () => {
  for (const { file, workflow } of cores) {
    const validate = workflow.nodes.find((n) => n.name === 'Validate Topic Research Package');
    assert.ok(validate, `${file}: missing the fail-closed validation call`);
    assert.match(validate.parameters.url, /\/v1\/research\/validate$/);
    assert.ok(workflow.nodes.some((n) => n.name === 'Research Valid?' && n.type === 'n8n-nodes-base.if'), `${file}: missing the valid/invalid branch`);
    assert.ok(workflow.nodes.some((n) => n.name === 'Build Research Retry Prompt'), `${file}: missing the bounded retry`);
    assert.ok(workflow.nodes.some((n) => n.name === 'Retry Research Valid?'), `${file}: retry must itself be validated once, not looped indefinitely`);
    // The retry prompt must only ever be reached from the first Research Valid? gate (a validator
    // rejection) or the first Research Parsed? gate (a raw JSON-parse failure) -- if anything else
    // points at it, including a path back into itself or into Research with Claude, the retry is
    // no longer bounded to exactly one attempt.
    assert.deepEqual(new Set(incomingSources(workflow, 'Build Research Retry Prompt')), new Set(['Research Valid?', 'Research Parsed?']), `${file}: retry path is not bounded to a single attempt`);
  }
});

// A live run against a real model reproduced this exact waste: the validator's failureCode
// NO_IN_SCOPE_RESEARCH means the model was correctly given qualified evidence and correctly found
// no real candidate in it -- retrying spends a second model call to re-ask the identical question
// against the identical evidence, which can only ever repeat the same answer. Both the first and
// retry validation results must intercept that specific failureCode before it reaches the
// content-defect retry/invalid-research path.
test('a validator NO_IN_SCOPE_RESEARCH result short-circuits straight to a skip instead of spending the bounded retry on an unwinnable re-ask', () => {
  for (const { file, workflow } of cores) {
    const gates = [
      ['Research Genuinely Empty?', 'Route Research Validation Result', 'Research Valid?'],
      ['Retry Research Genuinely Empty?', 'Route Retry Research Validation Result', 'Retry Research Valid?'],
    ];
    for (const [gate, validationSource, fallthrough] of gates) {
      const node = workflow.nodes.find((n) => n.name === gate);
      assert.ok(node, `${file}: missing ${gate}`);
      assert.deepEqual(incomingSources(workflow, gate), [validationSource], `${file}: ${gate} must sit directly after its validation call`);
      assert.deepEqual(new Set(outgoing(workflow, gate)), new Set(['Tag Skip: No In-Scope Research', fallthrough]), `${file}: ${gate} must branch to the shared skip or fall through to ${fallthrough}`);
    }
    // Behavioral: feed the tag node a validator-shaped payload (reasons array, no `reason` field)
    // and confirm it still extracts a human-readable reason instead of dropping it to null.
    const tag = workflow.nodes.find((n) => n.name === 'Tag Skip: No In-Scope Research');
    const fn = new Function('$json', '$', tag.parameters.jsCode);
    const result = fn(
      { valid: false, failureCode: 'NO_IN_SCOPE_RESEARCH', reasons: ['NO_IN_SCOPE_RESEARCH'], diagnostics: { qualifiedCount: 5 } },
      () => ({ item: { json: { topicSlug: 'git-cli' } } }),
    );
    assert.equal(result[0].json.outcome, 'no_in_scope_research', file);
    assert.equal(result[0].json.reason, 'NO_IN_SCOPE_RESEARCH', `${file}: must extract a reason from the validator's reasons array, not just retrieval's singular reason field`);
  }
});

// A live run reproduced this exact crash: a real, non-empty, well-terminated Claude response
// still failed strict JSON extraction, and there was no branch for that at all -- the Code node
// just threw, failing the whole execution. Both the first and retry parse must route through the
// exact same bounded retry-then-skip path, one stage earlier than validation.
test('a raw JSON-parse failure routes through the bounded retry, not a crash', () => {
  for (const { file, workflow } of cores) {
    const gates = [
      ['Research Parsed?', 'Normalize Research Package', 'Validate Topic Research Package', 'Build Research Retry Prompt'],
      ['Retry Research Parsed?', 'Normalize Retry Research Package', 'Validate Retry Research Package', 'Tag Skip: Invalid Research'],
    ];
    for (const [gate, normalizeSource, validatePath, failPath] of gates) {
      const node = workflow.nodes.find((n) => n.name === gate);
      assert.ok(node, `${file}: missing ${gate}`);
      assert.deepEqual(incomingSources(workflow, gate), [normalizeSource], `${file}: ${gate} must sit directly after its normalize call`);
      assert.deepEqual(new Set(outgoing(workflow, gate)), new Set([validatePath, failPath]), `${file}: ${gate} must branch to validation or the parse-failure path`);
    }
  }
});

test('both formats have a topic-aware editorial judge with a defense-in-depth topic-membership check', () => {
  for (const { file, workflow } of cores) {
    const judgePrompt = workflow.nodes.find((n) => n.name === 'Build Judgement Prompt');
    assert.ok(judgePrompt, `${file}: missing the topic-aware judge (both Tips and Trend must gate on topic membership before dialogue)`);
    assert.match(judgePrompt.parameters.jsCode, /This show covers ONLY/);
    assert.match(judgePrompt.parameters.jsCode, /topic_match/);
    assert.match(judgePrompt.parameters.jsCode, /off_topic/);
    assert.doesNotMatch(judgePrompt.parameters.jsCode, /__TOPIC_NAME__|__TOPIC_SCOPE__/);
    const worthWatching = workflow.nodes.find((n) => n.name === 'Topic Worth Watching?');
    assert.ok(worthWatching, `${file}: missing the accept/reject gate after judgement`);
    const conditions = worthWatching.parameters.conditions.conditions.map((c) => c.leftValue);
    assert.ok(conditions.includes('={{$json.worth_it}}') && conditions.includes('={{$json.topic_match}}'), `${file}: accept gate must require both worth_it and topic_match`);
  }
});

test('a skipped run can never reach dialogue, visuals, TTS, render, history, or publishing', () => {
  for (const { file, workflow } of cores) {
    const recordSkip = workflow.nodes.find((n) => n.name === 'Record Research Skip');
    assert.ok(recordSkip, `${file}: missing the skip-record write`);
    assert.match(recordSkip.parameters.url, /\/v1\/research\/record$/);
    // Record Research Skip must be a terminal node: if it had any outgoing connection, a skip
    // could still fall through into production nodes.
    assert.ok(!workflow.connections[recordSkip.name], `${file}: Record Research Skip must not connect onward to any other node`);
    for (const tag of ['Tag Skip: No In-Scope Research', 'Tag Skip: Invalid Research', 'Tag Skip: No Publishable Candidate']) {
      const node = workflow.nodes.find((n) => n.name === tag);
      assert.ok(node, `${file}: missing ${tag}`);
      assert.deepEqual([...outgoing(workflow, tag)], ['Record Research Skip'], `${file}: ${tag} must route only to Record Research Skip`);
    }
  }
});

test('every trend-format worker writes audio to a topic-prefixed path, not the original show\'s shared path', () => {
  for (const { file, workflow } of cores) {
    if (workflow.name !== 'Topic Research: Trend Core') continue;
    const normalizeNode = workflow.nodes.find((node) => node.name === 'Normalize Peter and Stewie Dialogue');
    const saveNode = workflow.nodes.find((node) => node.name === 'Save Dialogue Turn Audio');
    assert.match(normalizeNode.parameters.jsCode, /-trend-dialogue-/, file);
    assert.match(saveNode.parameters.fileName, /-trend-dialogue-/, file);
    assert.doesNotMatch(normalizeNode.parameters.jsCode, /`\/media\/dialogue-\$\{index\}/, `${file}: still writes to the original show's shared audio path`);
  }
});

test('every tips-format worker writes audio to a topic-prefixed path', () => {
  for (const { file, workflow } of cores) {
    if (workflow.name !== 'Topic Research: Tips Core') continue;
    const normalizeNode = workflow.nodes.find((node) => node.name === 'Normalize Dialogue');
    assert.match(normalizeNode.parameters.jsCode, /-tips-dialogue-/, file);
  }
});

test('every tips-format worker judges with Sonnet, matching the general tips show', () => {
  for (const { file, workflow } of cores) {
    if (workflow.name !== 'Topic Research: Tips Core') continue;
    const judgeNode = workflow.nodes.find((node) => node.name === 'Judge Topic with Claude');
    assert.match(judgeNode.parameters.jsonBody, /ANTHROPIC_JUDGE_MODEL/, file);
    assert.match(judgeNode.parameters.jsonBody, /claude-sonnet-5/, file);
  }
});

test('every tips-format worker gives the Sonnet judge room to think instead of burning max_tokens on it', () => {
  for (const { file, workflow } of cores) {
    if (workflow.name !== 'Topic Research: Tips Core') continue;
    const judgeNode = workflow.nodes.find((node) => node.name === 'Judge Topic with Claude');
    assert.match(judgeNode.parameters.jsonBody, /output_config:\s*\{\s*effort:\s*'low'\s*\}/, file);
    const [, maxTokens] = judgeNode.parameters.jsonBody.match(/max_tokens:\s*(\d+)/) ?? [];
    assert.ok(Number(maxTokens) >= 1024, `${file}: judge max_tokens (${maxTokens}) too low for Sonnet's default adaptive thinking`);
  }
});

test('the trend core also judges with Sonnet, closing the audited gap where Trend had no pre-production judge', () => {
  const trend = cores.find((c) => c.workflow.name === 'Topic Research: Trend Core');
  const judgeNode = trend.workflow.nodes.find((node) => node.name === 'Judge Topic with Claude');
  assert.ok(judgeNode, 'Trend Core must have a Judge Topic with Claude node');
  assert.match(judgeNode.parameters.jsonBody, /ANTHROPIC_JUDGE_MODEL/);
});

// A live production run against real search results and a real model hit exactly the historical
// incident this whole rewrite exists to close: Claude correctly found zero qualified candidates
// and returned {recommended_topic: null, candidates: []}, research-package-validator.mjs already
// treats that shape as a clean NO_IN_SCOPE_RESEARCH result (see its genuinelyEmpty check), but
// Normalize Research Package required recommended_topic.claims.length to accept a parse at all --
// so the genuinely-empty, valid answer was misclassified as malformed JSON and crashed the run
// before the validator ever saw it. This runs the actual node code (not a paraphrase of it) to
// prove that regression stays fixed.
function runNodeCode(workflow, nodeName, { json, itemsByNode = {} } = {}) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `missing node ${nodeName}`);
  const $ = (name) => ({ item: { json: itemsByNode[name] } });
  const $items = (name) => (itemsByNode[`${name}__items`] ?? [{ json: itemsByNode[name] }]);
  const fn = new Function('$json', '$', '$items', node.parameters.jsCode);
  return fn(json, $, $items);
}

test('Normalize Research Package accepts a genuinely-empty {recommended_topic: null, candidates: []} response instead of throwing RESEARCH_INVALID_JSON', () => {
  const genuinelyEmpty = { recommended_topic: null, candidates: [], research_policy: { requires_human_review: true, rejection_summary: 'no qualified candidates' } };
  for (const { file, workflow } of cores) {
    for (const nodeName of ['Normalize Research Package', 'Normalize Retry Research Package']) {
      const result = runNodeCode(workflow, nodeName, { json: { response: JSON.stringify(genuinelyEmpty), research_provider: 'anthropic' } });
      assert.equal(result[0].json.research.recommended_topic, null, `${file}: ${nodeName} must accept a genuinely-empty candidates response`);
      assert.deepEqual(result[0].json.research.candidates, [], `${file}: ${nodeName}`);
    }
  }
});

// A live run against a real model reproduced this exact failure: a complete, well-terminated
// (stop_reason: end_turn) 14KB Claude response still could not be strictly parsed into the
// expected schema. Normalize Research Package used to throw outright on that -- crashing the
// whole n8n execution -- instead of the bounded retry-then-skip the spec requires for "model
// returns invalid JSON". It must return a parse_failed marker instead of throwing, so the
// downstream Research/Retry Parsed? gate can route it through the same retry path a validator
// rejection already uses, not swallow it silently.
test('Normalize Research Package reports genuinely malformed output as parse_failed instead of crashing the execution (negative control)', () => {
  for (const { file, workflow } of cores) {
    for (const nodeName of ['Normalize Research Package', 'Normalize Retry Research Package']) {
      const malformed = runNodeCode(workflow, nodeName, { json: { response: 'this is not json at all and has no braces' } });
      assert.equal(malformed[0].json.parse_failed, true, `${file}: ${nodeName} must report a parse failure, not swallow every failure`);
      assert.equal(malformed[0].json.research, undefined, `${file}: ${nodeName} must not fabricate a research object for malformed output`);
      // A non-empty candidates array with a null recommended_topic is a different, genuine schema
      // violation (RECOMMENDATION_ORDER territory for the validator) -- the empty-response carve-out
      // must not accidentally admit it here too.
      const wrongShape = { recommended_topic: null, candidates: [{ tool_name: 'x' }] };
      const result = runNodeCode(workflow, nodeName, { json: { response: JSON.stringify(wrongShape) } });
      assert.equal(result[0].json.parse_failed, true, `${file}: ${nodeName} must not treat a null recommendation with non-empty candidates as the empty carve-out`);
    }
  }
});

test('Normalize Research Package still accepts a normal non-empty research response (positive control)', () => {
  const populated = { recommended_topic: { tool_name: 'Foo', topic: 'Foo does X', claims: [{ claim_id: 'c1', source_url: 'https://example.com' }] }, candidates: [{ tool_name: 'Foo', topic: 'Foo does X', claims: [{ claim_id: 'c1', source_url: 'https://example.com' }] }] };
  for (const { file, workflow } of cores) {
    const result = runNodeCode(workflow, 'Normalize Research Package', { json: { response: JSON.stringify(populated) } });
    assert.equal(result[0].json.research.recommended_topic.tool_name, 'Foo', file);
  }
});

test('research retrieval, validation, and record calls request only the core\'s own fixed format', () => {
  for (const { file, workflow, format } of cores) {
    for (const name of ['Fetch Topic-Specific Research Sources', 'Validate Topic Research Package', 'Validate Retry Research Package']) {
      const httpNode = workflow.nodes.find((n) => n.name === name);
      assert.ok(httpNode, `${file}: missing ${name}`);
      assert.match(httpNode.parameters.jsonBody, new RegExp(`format:\\s*'${format}'`), `${file}: ${name} must send its own fixed format`);
      assert.doesNotMatch(httpNode.parameters.jsonBody, /\bformat:\s*\$json\.format\b/, `${file}: ${name} must not forward a caller-supplied format`);
    }
  }
});

// A live run proved this matters: flipping the legacy shows' shared ANTHROPIC_MODEL to Sonnet to
// improve topic-research quality also silently changed model behavior for two unrelated
// pre-existing workflows that read the exact same variable, and one of them then timed out
// (Sonnet's default adaptive thinking exceeded its node's fixed timeout, since it had never been
// given the effort:'low' treatment the judge already had). Every generation call in the topic
// cores must use its own dedicated env var, and any call defaulting to Sonnet must bound its
// thinking effort so it can't blow its own timeout or token budget.
test('every topic-core generation call is isolated from the legacy shows\' shared ANTHROPIC_MODEL, and every Sonnet-defaulting call bounds its own thinking effort', () => {
  for (const { file, workflow } of cores) {
    const dialogueNodeName = workflow.name === 'Topic Research: Trend Core' ? 'Write Peter and Stewie Dialogue with Claude' : 'Write Dialogue with Claude';
    const sonnetDefaultingNodes = [
      ['Research with Claude', 'ANTHROPIC_TOPIC_RESEARCH_MODEL'],
      ['Retry Research with Claude', 'ANTHROPIC_TOPIC_RESEARCH_MODEL'],
      [dialogueNodeName, 'ANTHROPIC_TOPIC_DIALOGUE_MODEL'],
      ['Write Instagram Caption with Claude', 'ANTHROPIC_TOPIC_DIALOGUE_MODEL'],
    ];
    for (const [name, envVar] of sonnetDefaultingNodes) {
      const node = workflow.nodes.find((n) => n.name === name);
      assert.ok(node, `${file}: missing ${name}`);
      assert.match(node.parameters.jsonBody, new RegExp(`\\$env\\.${envVar}\\s*\\|\\|\\s*'claude-sonnet-5'`), `${file}: ${name} must default to Sonnet on its own dedicated env var`);
      assert.doesNotMatch(node.parameters.jsonBody, /\$env\.ANTHROPIC_MODEL\b/, `${file}: ${name} must not read the legacy shows' shared ANTHROPIC_MODEL`);
      assert.match(node.parameters.jsonBody, /output_config:\s*\{\s*effort:\s*'low'\s*\}/, `${file}: ${name} defaults to Sonnet but never bounds its thinking effort`);
    }
    // The judge already had its own dedicated var and effort:'low' before this fix -- confirm it
    // is untouched, not that this test is accidentally checking the same node twice.
    const judge = workflow.nodes.find((n) => n.name === 'Judge Topic with Claude');
    assert.match(judge.parameters.jsonBody, /\$env\.ANTHROPIC_JUDGE_MODEL/, file);
  }
});
