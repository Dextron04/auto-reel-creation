import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  cronFromScheduleNode,
  fetchExecutionPages,
  findManualTriggerPath,
  findScheduleTriggerNode,
  formatScheduledRun,
  mapExecution,
  mergeExecutionDetails,
  nextCronOccurrence,
  selectWorkflow,
  triggerManualRun,
  workflowTopology,
} from './operations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const WORKFLOW_PATH = path.join(ROOT, 'n8n/workflows/research-and-render-reel.json');

const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const RENDERER_BASE_URL = process.env.RENDERER_URL_PUBLIC ?? 'http://localhost:3001';
const PORT = process.env.DASHBOARD_PORT ?? 4000;
const SCHEDULE_TIMEZONE = process.env.GENERIC_TIMEZONE ?? 'America/Chicago';
const DEFAULT_WORKFLOW_NAME = 'Research and Render Local AI Reel';

// Keyed by the RESOLVED n8n workflow id, not by the request's selector string, so "the original
// show" and "id abc123" share one cache entry once resolved. Selection itself is cheap enough
// (one small list call) to skip caching and just resolve fresh on every request — the heavier
// full node list is what's worth caching.
const workflowGraphCache = new Map();
const executionDetailCache = new Map();
let manualTriggerPending = false;

function n8nConfigured() { return Boolean(N8N_API_KEY); }

async function n8nFetch(urlPath, opts = {}) {
  const res = await fetch(`${N8N_BASE_URL}${urlPath}`, {
    ...opts,
    headers: {'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json', ...opts.headers},
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`N8N_API_ERROR:${res.status}:${body?.message ?? 'unknown'}`);
  return body;
}

// `requested` is whatever the dashboard's workflow selector sent (an id or an exact name), or
// undefined for "whatever the page defaults to" — always the original show, so old bookmarks
// and the existing deployment status check keep working unchanged.
async function resolveWorkflow(requested) {
  const list = await n8nFetch('/api/v1/workflows?limit=250');
  const match = selectWorkflow(list.data ?? [], requested, DEFAULT_WORKFLOW_NAME);
  if (!match) throw new Error('N8N_WORKFLOW_NOT_FOUND');
  return match;
}

async function fetchWorkflow(requested, {fresh = false} = {}) {
  const resolved = await resolveWorkflow(requested);
  if (!fresh && workflowGraphCache.has(resolved.id)) return {id: resolved.id, ...workflowGraphCache.get(resolved.id)};
  const workflow = await n8nFetch(`/api/v1/workflows/${resolved.id}`);
  const graph = {workflow, nodes: workflowTopology(workflow)};
  workflowGraphCache.set(resolved.id, graph);
  return {id: resolved.id, ...graph};
}

async function fetchExecutionDetail(summary, workflowNodes) {
  if (summary.status !== 'running' && executionDetailCache.has(summary.id)) return executionDetailCache.get(summary.id);
  const detail = mapExecution(
    await n8nFetch(`/api/v1/executions/${encodeURIComponent(summary.id)}?includeData=true`),
    workflowNodes,
  );
  if (summary.status !== 'running') {
    executionDetailCache.set(summary.id, detail);
    while (executionDetailCache.size > 100) executionDetailCache.delete(executionDetailCache.keys().next().value);
  }
  return detail;
}

function validateCron(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(f => /^[0-9*/,-]+$/.test(f));
}

// The only workflow this file fallback can represent is the original show it's checked in for —
// it's a "no N8N_API_KEY" dev convenience, not a general mechanism, so it's never consulted for
// an explicit workflow selection (that always requires the API to even list workflows).
async function readLocalScheduleFile() {
  const raw = await fs.readFile(WORKFLOW_PATH, 'utf8');
  const workflow = JSON.parse(raw);
  const node = findScheduleTriggerNode(workflow);
  if (!node) throw new Error('SCHEDULE_NODE_NOT_FOUND');
  return cronFromScheduleNode(node);
}

async function writeLocalScheduleFile(cron) {
  const raw = await fs.readFile(WORKFLOW_PATH, 'utf8');
  const workflow = JSON.parse(raw);
  const node = findScheduleTriggerNode(workflow);
  if (!node) throw new Error('SCHEDULE_NODE_NOT_FOUND');
  node.parameters.rule.interval[0].expression = cron;
  await fs.writeFile(WORKFLOW_PATH, JSON.stringify(workflow, null, 2) + '\n');
}

async function fetchHealth(url) {
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(3000)});
    if (!res.ok) return {ok: false};
    return {ok: true, body: await res.json().catch(() => ({}))};
  } catch {
    return {ok: false};
  }
}

function isPlaceholder(value) {
  return !value || value.startsWith('replace-with');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(OUTPUT_DIR));
app.get('/health', (_req, res) => res.json({ready: true, service: 'dashboard'}));

app.get('/api/workflows', async (_req, res) => {
  if (!n8nConfigured()) return res.json({configured: false, workflows: [], defaultName: DEFAULT_WORKFLOW_NAME});
  try {
    const list = await n8nFetch('/api/v1/workflows?limit=250');
    const workflows = (list.data ?? [])
      .map(w => ({id: w.id, name: w.name, active: w.active}))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({configured: true, workflows, defaultName: DEFAULT_WORKFLOW_NAME});
  } catch (error) { res.status(500).json({configured: true, workflows: [], defaultName: DEFAULT_WORKFLOW_NAME, error: error.message}); }
});

app.get('/api/status', async (req, res) => {
  const [renderer, n8nHealth] = await Promise.all([
    fetchHealth(`${RENDERER_BASE_URL}/health`),
    fetchHealth(`${N8N_BASE_URL}/healthz`),
  ]);

  let workflow = null;
  let n8nError = null;
  if (n8nConfigured()) {
    try {
      const {id, workflow: wf, nodes} = await fetchWorkflow(req.query.workflow, {fresh: true});
      workflow = {id, name: wf.name, active: wf.active, updatedAt: wf.updatedAt, nodeCount: nodes.length};
    } catch (error) { n8nError = error.message; }
  }

  const envWarnings = [];
  if (isPlaceholder(process.env.INSTAGRAM_ACCESS_TOKEN) && process.env.PUBLISHING_ENABLED === 'true') {
    envWarnings.push({key: 'INSTAGRAM_ACCESS_TOKEN', message: 'Publishing enabled but Instagram token missing.'});
  }
  if (isPlaceholder(process.env.ANTHROPIC_API_KEY)) {
    envWarnings.push({key: 'ANTHROPIC_API_KEY', message: 'Anthropic API key not set — research/dialogue steps will fall back to local Qwen.'});
  }
  if (process.env.PUBLISHING_ENABLED !== 'true') {
    envWarnings.push({key: 'PUBLISHING_ENABLED', message: 'Publishing to Instagram is disabled (PUBLISHING_ENABLED=false).', level: 'info'});
  }

  res.json({
    renderer: {ok: renderer.ok, ...renderer.body},
    n8n: {ok: n8nHealth.ok, apiConfigured: n8nConfigured(), workflow, error: n8nError},
    envWarnings,
  });
});

app.get('/api/schedule', async (req, res) => {
  try {
    if (n8nConfigured()) {
      const {workflow: wf} = await fetchWorkflow(req.query.workflow, {fresh: true});
      const node = findScheduleTriggerNode(wf);
      const cron = cronFromScheduleNode(node);
      const nextRun = node && wf.active ? nextCronOccurrence(cron, new Date(), SCHEDULE_TIMEZONE) : null;
      return res.json({
        cron, hasSchedule: Boolean(node), source: 'n8n', active: wf.active, timezone: SCHEDULE_TIMEZONE,
        nextRunAt: nextRun?.toISOString() ?? null,
        nextRunLabel: nextRun ? formatScheduledRun(nextRun, SCHEDULE_TIMEZONE) : null,
      });
    }
    const cron = await readLocalScheduleFile();
    const nextRun = nextCronOccurrence(cron, new Date(), SCHEDULE_TIMEZONE);
    res.json({
      cron, hasSchedule: true, source: 'file', timezone: SCHEDULE_TIMEZONE,
      nextRunAt: nextRun?.toISOString() ?? null,
      nextRunLabel: nextRun ? formatScheduledRun(nextRun, SCHEDULE_TIMEZONE) : null,
    });
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.post('/api/schedule', async (req, res) => {
  const {cron, workflow: requested} = req.body ?? {};
  if (!validateCron(cron)) return res.status(400).json({error: 'Invalid cron expression — expected 5 space-separated fields.'});
  if (!n8nConfigured()) return res.status(400).json({error: 'N8N_API_KEY not configured — cannot edit the live schedule.'});

  try {
    const {id, workflow: wf} = await fetchWorkflow(requested, {fresh: true});
    const node = findScheduleTriggerNode(wf);
    if (!node) return res.status(400).json({error: 'This workflow has no independent schedule to edit — it runs only when dispatched by another workflow.'});
    node.parameters.rule.interval[0].expression = cron;
    await n8nFetch(`/api/v1/workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify({name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {}}),
    });
    workflowGraphCache.delete(id);

    let fileWarning = null;
    if (!requested || wf.name === DEFAULT_WORKFLOW_NAME) {
      try { await writeLocalScheduleFile(cron); }
      catch (error) { fileWarning = `Live schedule updated, but failed to sync n8n/workflows/research-and-render-reel.json: ${error.message}`; }
    }

    const nextRun = nextCronOccurrence(cron, new Date(), SCHEDULE_TIMEZONE);
    res.json({
      ok: true,
      cron,
      fileWarning,
      nextRunAt: nextRun?.toISOString() ?? null,
      nextRunLabel: nextRun ? formatScheduledRun(nextRun, SCHEDULE_TIMEZONE) : null,
    });
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/videos', async (_req, res) => {
  try {
    const entries = await fs.readdir(OUTPUT_DIR);
    const videos = await Promise.all(
      entries.filter(f => f.endsWith('.mp4')).map(async file => {
        const full = path.join(OUTPUT_DIR, file);
        const stat = await fs.stat(full);
        let report = null;
        try { report = JSON.parse(await fs.readFile(`${full}.json`, 'utf8')); } catch { /* no sidecar */ }
        return {
          file,
          url: `/videos/${encodeURIComponent(file)}`,
          sizeBytes: stat.size,
          createdAt: stat.mtime.toISOString(),
          durationSeconds: report?.durationSeconds ?? null,
          captionCount: report?.captionCount ?? null,
          visualCount: report?.visualCount ?? null,
        };
      })
    );
    videos.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(videos);
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/executions', async (req, res) => {
  if (!n8nConfigured()) return res.json({configured: false, recent: []});
  try {
    const {id, nodes: workflowNodes} = await fetchWorkflow(req.query.workflow);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const list = await fetchExecutionPages(n8nFetch, id, cursor);
    const summaries = (list.data ?? []).map(execution => mapExecution(execution));
    const detailedExecutions = await Promise.all(
      summaries
        .filter((execution, index) => execution.status === 'running' || index < 12)
        .map(async execution => {
          try {
            return await fetchExecutionDetail(execution, workflowNodes);
          } catch {
            return execution;
          }
        }),
    );
    const executions = mergeExecutionDetails(summaries, detailedExecutions);
    res.json({
      configured: true,
      executions,
      running: executions.filter(exec => exec.status === 'running'),
      workflowNodes,
      nextCursor: list.nextCursor ?? null,
    });
  } catch (error) { res.status(500).json({configured: true, error: error.message, executions: [], running: [], nextCursor: null}); }
});

app.post('/api/run', async (req, res) => {
  if (!n8nConfigured()) {
    return res.status(503).json({error: 'N8N_API_KEY not configured — cannot start the workflow.'});
  }
  if (manualTriggerPending) {
    return res.status(409).json({error: 'A manual start request is already in progress.'});
  }

  manualTriggerPending = true;
  try {
    const {id, workflow: wf} = await fetchWorkflow(req.body?.workflow);
    const webhookPath = findManualTriggerPath(wf);
    if (!webhookPath) return res.status(400).json({error: 'This workflow has no manual trigger webhook.'});
    const list = await fetchExecutionPages(n8nFetch, id);
    const result = await triggerManualRun(list.data ?? [], () => n8nFetch(`/webhook/${webhookPath}`, {
      method: 'POST',
      body: JSON.stringify({source: 'reel-operations-dashboard'}),
    }));

    if (!result.accepted) {
      return res.status(409).json({error: result.message, runningExecutionId: result.runningExecutionId});
    }
    return res.status(202).json(result);
  } catch (error) {
    return res.status(502).json({error: `Could not start workflow: ${error.message}`});
  } finally {
    manualTriggerPending = false;
  }
});

app.listen(PORT, () => console.log(`dashboard listening on ${PORT}`));
