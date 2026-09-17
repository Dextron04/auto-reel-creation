// The ten topic reel workflows used to be full, independently hand-edited pipelines (~1500-1900
// lines each) that only differed by a handful of literal strings (slug, display name, webhook
// path, history namespace, audio path prefix). That duplication is exactly what let the two
// production incidents this generator closes happen: a hand-edited copy drifting out of sync with
// its siblings. Now the two Topic Research core workflows own all pipeline logic, and this script
// owns the mapping from each wrapper's immutable operational identifiers to a thin file that
// attaches its topic slug and calls the correct shared core.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_SLUGS, TOPIC_FORMATS } from '../renderer/src/research-topic-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = path.join(ROOT, 'n8n', 'workflows');

// Preserved verbatim from the pre-consolidation workflow files: n8n's deploy sync
// (scripts/sync-n8n-workflow.mjs) matches an existing workflow by exact `name`, and the dashboard
// and round-robin orchestrator call these exact webhook paths / dispatch by the workflow that
// owns them. Changing any of these breaks a live operational entry point.
export const WRAPPERS = Object.freeze([
  { slug: 'agentic-ai', format: 'tips', id: 'TopicAgenticAiTips', name: 'Agentic AI & Coding Agents: Tips Reel', webhookPath: 'topic-agentic-ai-tips-run', webhookId: 'c2e29c5b-4281-4dc6-9a22-3b567df97852' },
  { slug: 'agentic-ai', format: 'trend', id: 'TopicAgenticAiTrend', name: 'Agentic AI & Coding Agents: Trend Reel', webhookPath: 'topic-agentic-ai-trend-run', webhookId: '3103fda2-9737-4144-8d87-7d75e98f5773' },
  { slug: 'editor-ide', format: 'tips', id: 'TopicEditorIdeTips', name: 'Editor & IDE Power Features: Tips Reel', webhookPath: 'topic-editor-ide-tips-run', webhookId: '80d4bf07-39fa-42da-a98d-e566d1a6c25a' },
  { slug: 'editor-ide', format: 'trend', id: 'TopicEditorIdeTrend', name: 'Editor & IDE Power Features: Trend Reel', webhookPath: 'topic-editor-ide-trend-run', webhookId: '8a6b6e3c-5390-4f63-97a1-206dd5f00c26' },
  { slug: 'git-cli', format: 'tips', id: 'TopicGitCliTips', name: 'Git & CLI Tricks: Tips Reel', webhookPath: 'topic-git-cli-tips-run', webhookId: 'bda54ec5-ad22-443a-a781-a67fd88d7a1c' },
  { slug: 'git-cli', format: 'trend', id: 'TopicGitCliTrend', name: 'Git & CLI Tricks: Trend Reel', webhookPath: 'topic-git-cli-trend-run', webhookId: '2e729028-7aeb-4d53-a2f8-ff0073c6948e' },
  { slug: 'databases-performance', format: 'tips', id: 'TopicDatabasesPerformanceTips', name: 'Databases & Performance: Tips Reel', webhookPath: 'topic-databases-performance-tips-run', webhookId: '90eeee9a-c071-4f27-b04c-ab5facc7e00d' },
  { slug: 'databases-performance', format: 'trend', id: 'TopicDatabasesPerformanceTrend', name: 'Databases & Performance: Trend Reel', webhookPath: 'topic-databases-performance-trend-run', webhookId: '4ae2a587-79a3-40d6-995a-5d057d61e1a6' },
  { slug: 'debugging-observability', format: 'tips', id: 'TopicDebuggingObservabilityTips', name: 'Debugging & Observability: Tips Reel', webhookPath: 'topic-debugging-observability-tips-run', webhookId: '3352f520-335e-4d00-8651-7ffee84645df' },
  { slug: 'debugging-observability', format: 'trend', id: 'TopicDebuggingObservabilityTrend', name: 'Debugging & Observability: Trend Reel', webhookPath: 'topic-debugging-observability-trend-run', webhookId: '29847fcc-c649-4883-b528-7c911d7b3b49' },
]);

const CORE_ENV_VAR = Object.freeze({ tips: 'TOPIC_TIPS_CORE_WORKFLOW_ID', trend: 'TOPIC_TREND_CORE_WORKFLOW_ID' });
const CORE_LABEL = Object.freeze({ tips: 'Tips Core', trend: 'Trend Core' });

function assertKnownWrapper({ slug, format }) {
  if (!TOPIC_SLUGS.includes(slug)) throw new Error(`BUILD_TOPIC_WORKFLOWS_UNKNOWN_SLUG:${slug}`);
  if (!TOPIC_FORMATS.includes(format)) throw new Error(`BUILD_TOPIC_WORKFLOWS_UNKNOWN_FORMAT:${format}`);
}

// A stable, non-random versionId per wrapper keeps regeneration deterministic (required for
// --check to be meaningful) without needing n8n's own UUID generator.
function stableVersionId(slug, format) {
  const seed = `${slug}:${format}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-0000-4000-8000-${format === 'tips' ? '000000000001' : '000000000002'}`.slice(0, 36);
}

export function buildWrapperWorkflow(entry) {
  assertKnownWrapper(entry);
  const { slug, format, id, name, webhookPath, webhookId } = entry;
  const dashboardTriggerName = `Run Topic ${format === 'tips' ? 'Tips' : 'Trend'} Reel from Dashboard`;
  const coreNodeName = `Execute Topic Research: ${CORE_LABEL[format]}`;
  return {
    id,
    name,
    nodes: [
      {
        parameters: {},
        id: 'wrapper-execute-trigger',
        name: 'When Executed by Round Robin',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1,
        position: [0, 0],
      },
      {
        parameters: { httpMethod: 'POST', path: webhookPath, options: {} },
        id: 'wrapper-dashboard-trigger',
        name: dashboardTriggerName,
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 200],
        webhookId,
      },
      {
        // The slug is a literal here, not an expression -- it is this wrapper file's one
        // immutable fact, attached the same way regardless of which trigger fired it.
        parameters: { jsCode: `return [{json: {topicSlug: ${JSON.stringify(slug)}}}];\n` },
        id: 'wrapper-attach-topic-slug',
        name: 'Attach Topic Slug',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [240, 100],
      },
      {
        // The core workflows are imported into n8n once by an operator (they cannot be created by
        // this file sync alone -- see README), so their real n8n workflow id is only known at
        // deploy time. That id is supplied via environment variable rather than hard-coded here.
        parameters: {
          source: 'database',
          workflowId: `={{$env.${CORE_ENV_VAR[format]}}}`,
          mode: 'once',
          options: { waitForSubWorkflow: true },
        },
        id: 'wrapper-execute-core',
        name: coreNodeName,
        type: 'n8n-nodes-base.executeWorkflow',
        typeVersion: 1,
        position: [480, 100],
      },
    ],
    connections: {
      'When Executed by Round Robin': { main: [[{ node: 'Attach Topic Slug', type: 'main', index: 0 }]] },
      [dashboardTriggerName]: { main: [[{ node: 'Attach Topic Slug', type: 'main', index: 0 }]] },
      'Attach Topic Slug': { main: [[{ node: coreNodeName, type: 'main', index: 0 }]] },
    },
    active: true,
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
    versionId: stableVersionId(slug, format),
  };
}

function wrapperFileName({ slug, format }) {
  return `topic-${slug}-${format}-reel.json`;
}

function serialize(workflow) {
  return JSON.stringify(workflow, null, 2) + '\n';
}

export function generateAll() {
  assert.equal(WRAPPERS.length, TOPIC_SLUGS.length * TOPIC_FORMATS.length, 'wrapper roster must cover every topic x format combination exactly once');
  const seenSlugFormat = new Set();
  const seenNames = new Set();
  const seenPaths = new Set();
  const files = new Map();
  for (const entry of WRAPPERS) {
    const key = `${entry.slug}:${entry.format}`;
    assert.ok(!seenSlugFormat.has(key), `duplicate wrapper entry for ${key}`);
    seenSlugFormat.add(key);
    assert.ok(!seenNames.has(entry.name), `duplicate wrapper name ${entry.name}`);
    seenNames.add(entry.name);
    assert.ok(!seenPaths.has(entry.webhookPath), `duplicate webhook path ${entry.webhookPath}`);
    seenPaths.add(entry.webhookPath);
    files.set(wrapperFileName(entry), serialize(buildWrapperWorkflow(entry)));
  }
  for (const slug of TOPIC_SLUGS) for (const format of TOPIC_FORMATS) {
    assert.ok(seenSlugFormat.has(`${slug}:${format}`), `missing wrapper entry for ${slug}:${format}`);
  }
  return files;
}

async function writeAll(files) {
  for (const [fileName, contents] of files) {
    await fs.writeFile(path.join(WORKFLOWS_DIR, fileName), contents);
  }
}

async function checkAll(files) {
  const drifted = [];
  for (const [fileName, expected] of files) {
    const target = path.join(WORKFLOWS_DIR, fileName);
    let actual;
    try { actual = await fs.readFile(target, 'utf8'); }
    catch { drifted.push(`${fileName}: missing`); continue; }
    if (actual !== expected) drifted.push(`${fileName}: does not match generator output`);
  }
  return drifted;
}

async function main() {
  const files = generateAll();
  if (process.argv.includes('--check')) {
    const drifted = await checkAll(files);
    if (drifted.length) {
      console.error('topic workflow drift detected:');
      for (const line of drifted) console.error(`  - ${line}`);
      console.error('\nRun `node scripts/build-topic-workflows.mjs` to regenerate.');
      process.exitCode = 1;
      return;
    }
    console.log(`all ${files.size} generated topic workflows match their canonical generator`);
    return;
  }
  await writeAll(files);
  console.log(`wrote ${files.size} topic workflow wrappers to ${path.relative(ROOT, WORKFLOWS_DIR)}`);
}

const isEntryModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryModule) await main();
