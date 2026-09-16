import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';

const dir = new URL('.', import.meta.url);
const files = (await readdir(dir)).filter((name) => /^topic-.+-(tips|trend)-reel\.json$/.test(name));
assert.equal(files.length, 10, `expected 5 topics x 2 formats = 10 topic workflow files, found ${files.length}: ${files.join(', ')}`);

const workflows = await Promise.all(files.map(async (file) => {
  const slug = file.match(/^topic-(.+)-(tips|trend)-reel\.json$/)[1];
  const format = file.match(/^topic-(.+)-(tips|trend)-reel\.json$/)[2];
  const workflow = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
  return {file, slug, format, workflow};
}));

// Every $items()/$() string reference inside a Code node must point at a node that actually
// exists in that same file. This exact bug class (a copied snippet's hardcoded node name left
// stale after a rename) broke the tips-format workflow in production twice already.
test('every topic workflow: no dangling $items()/$() node references', () => {
  for (const {file, workflow} of workflows) {
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

// neverError only works at options.response.response.neverError on this n8n version -- the flat
// options.neverError shape is silently dropped on save. This also broke production twice.
test('every topic workflow: neverError never sits at the flat options.neverError path', () => {
  for (const {file, workflow} of workflows) {
    for (const node of workflow.nodes) {
      const options = node.parameters?.options;
      if (options && typeof options === 'object') {
        assert.equal(options.neverError, undefined, `${file}: ${node.name} has neverError at the flat (broken) path`);
      }
    }
  }
});

test('every topic workflow has a unique webhook path and a unique n8n-facing workflow name', () => {
  const paths = new Set();
  const names = new Set();
  for (const {file, workflow} of workflows) {
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.webhook') {
        assert.ok(!paths.has(node.parameters.path), `${file}: duplicate webhook path ${node.parameters.path}`);
        paths.add(node.parameters.path);
      }
    }
    assert.ok(!names.has(workflow.name), `duplicate workflow name ${workflow.name}`);
    names.add(workflow.name);
  }
  assert.equal(paths.size, 10);
});

test('every topic workflow is driven by the round-robin orchestrator, not its own schedule', () => {
  for (const {file, workflow} of workflows) {
    const types = workflow.nodes.map((node) => node.type);
    assert.ok(types.includes('n8n-nodes-base.executeWorkflowTrigger'), `${file}: missing Execute Workflow Trigger entry point`);
    assert.ok(!types.includes('n8n-nodes-base.scheduleTrigger'), `${file}: must not have its own schedule -- the orchestrator owns scheduling`);
  }
});

test('every topic workflow research prompt is scoped to its own topic and excludes other topics', () => {
  for (const {file, format, workflow} of workflows) {
    const promptNodeName = format === 'tips' ? 'Build Research Prompt' : 'Build Research Prompt';
    const promptNode = workflow.nodes.find((node) => node.name === promptNodeName && node.parameters?.jsCode);
    assert.ok(promptNode, `${file}: missing research prompt node`);
    assert.match(promptNode.parameters.jsCode, /This show covers ONLY/, file);
    assert.match(promptNode.parameters.jsCode, /Reject every candidate outside that scope/, file);
    assert.doesNotMatch(promptNode.parameters.jsCode, /__TOPIC_NAME__|__TOPIC_SCOPE__/, `${file}: unsubstituted topic placeholder`);
  }
});

test('every topic workflow namespaces its topic-history pool by slug and format, independent of every other worker', () => {
  const allNamespaceStrings = new Set();
  for (const {file, slug, format, workflow} of workflows) {
    const expected = format === 'tips' ? [`${slug}-tips`, `${slug}-tips-rejected`] : [`${slug}-trend`];
    const bodyText = JSON.stringify(workflow);
    for (const ns of expected) {
      assert.match(bodyText, new RegExp(`namespace[=:]\\s*'?${ns}\\b`), `${file}: missing namespace ${ns}`);
      assert.ok(!allNamespaceStrings.has(ns), `namespace ${ns} reused across workflow files`);
      allNamespaceStrings.add(ns);
    }
  }
});

test('every trend-format worker writes audio to a topic-prefixed path, not the original show\'s shared path', () => {
  for (const {file, slug, format, workflow} of workflows) {
    if (format !== 'trend') continue;
    const normalizeNode = workflow.nodes.find((node) => node.name === 'Normalize Peter and Stewie Dialogue');
    const saveNode = workflow.nodes.find((node) => node.name === 'Save Dialogue Turn Audio');
    assert.match(normalizeNode.parameters.jsCode, new RegExp(`/media/${slug}-trend-dialogue-`), file);
    assert.match(saveNode.parameters.fileName, new RegExp(`/media/${slug}-trend-dialogue-`), file);
    assert.doesNotMatch(normalizeNode.parameters.jsCode, /`\/media\/dialogue-\$\{index\}/, `${file}: still writes to the original show's shared audio path`);
  }
});

test('every tips-format worker writes audio to a topic-prefixed path', () => {
  for (const {file, slug, format, workflow} of workflows) {
    if (format !== 'tips') continue;
    const normalizeNode = workflow.nodes.find((node) => node.name === 'Normalize Dialogue');
    assert.match(normalizeNode.parameters.jsCode, new RegExp(`/media/${slug}-tips-dialogue-`), file);
  }
});

test('every tips-format worker judges with Sonnet, matching the general tips show', () => {
  for (const {file, format, workflow} of workflows) {
    if (format !== 'tips') continue;
    const judgeNode = workflow.nodes.find((node) => node.name === 'Judge Topic with Claude');
    assert.match(judgeNode.parameters.jsonBody, /ANTHROPIC_JUDGE_MODEL/, file);
    assert.match(judgeNode.parameters.jsonBody, /claude-sonnet-5/, file);
  }
});

test('every tips-format worker gives the Sonnet judge room to think instead of burning max_tokens on it', () => {
  // Sonnet 5 runs adaptive thinking by default -- a live run hit stop_reason: max_tokens with an
  // empty thinking block and no text at all because max_tokens: 512 left no room after thinking,
  // so every judgement silently fell back to Qwen. effort: 'low' plus a higher ceiling fixes it.
  for (const {file, format, workflow} of workflows) {
    if (format !== 'tips') continue;
    const judgeNode = workflow.nodes.find((node) => node.name === 'Judge Topic with Claude');
    assert.match(judgeNode.parameters.jsonBody, /output_config:\s*\{\s*effort:\s*'low'\s*\}/, file);
    const [, maxTokens] = judgeNode.parameters.jsonBody.match(/max_tokens:\s*(\d+)/) ?? [];
    assert.ok(Number(maxTokens) >= 1024, `${file}: judge max_tokens (${maxTokens}) too low for Sonnet's default adaptive thinking`);
  }
});

test('every topic workflow reuses the same 11-feed research pool as the original show', () => {
  for (const {file, workflow} of workflows) {
    assert.equal(workflow.nodes.find((node) => node.name === 'Merge Research Sources').parameters.numberInputs, 11, file);
  }
});
