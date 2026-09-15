import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  executionListPath,
  formatScheduledRun,
  mapExecution,
  mergeExecutionDetails,
  nextCronOccurrence,
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
const SCHEDULE_NODE_NAME = 'Research Twice Daily';

let cachedWorkflowId = null;
let cachedWorkflowGraph = null;
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

async function findWorkflowId() {
  if (cachedWorkflowId) return cachedWorkflowId;
  const list = await n8nFetch('/api/v1/workflows?limit=250');
  // Multiple workflows can share a name (a stale re-import left over from manual UI work, for
  // example) — the active one is the one actually running scheduled/manual executions.
  const matches = (list.data ?? []).filter(w => w.name === 'Research and Render Local AI Reel');
  const match = matches.find(w => w.active) ?? matches[0];
  if (!match) throw new Error('N8N_WORKFLOW_NOT_FOUND');
  cachedWorkflowId = match.id;
  return cachedWorkflowId;
}

async function fetchWorkflow({fresh = false} = {}) {
  const id = await findWorkflowId();
  if (!fresh && cachedWorkflowGraph) return {id, ...cachedWorkflowGraph};
  const workflow = await n8nFetch(`/api/v1/workflows/${id}`);
  cachedWorkflowGraph = {workflow, nodes: workflowTopology(workflow)};
  return {id, ...cachedWorkflowGraph};
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

function findScheduleNode(workflow) {
  const node = workflow.nodes.find(n => n.name === SCHEDULE_NODE_NAME);
  if (!node) throw new Error('SCHEDULE_NODE_NOT_FOUND');
  return node;
}

function cronFromNode(node) {
  return node.parameters?.rule?.interval?.[0]?.expression ?? null;
}

function validateCron(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(f => /^[0-9*/,-]+$/.test(f));
}

async function readLocalScheduleFile() {
  const raw = await fs.readFile(WORKFLOW_PATH, 'utf8');
  const workflow = JSON.parse(raw);
  const node = findScheduleNode(workflow);
  return cronFromNode(node);
}

async function writeLocalScheduleFile(cron) {
  const raw = await fs.readFile(WORKFLOW_PATH, 'utf8');
  const workflow = JSON.parse(raw);
  const node = findScheduleNode(workflow);
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

app.get('/api/status', async (_req, res) => {
  const [renderer, n8nHealth] = await Promise.all([
    fetchHealth(`${RENDERER_BASE_URL}/health`),
    fetchHealth(`${N8N_BASE_URL}/healthz`),
  ]);

  let workflow = null;
  let n8nError = null;
  if (n8nConfigured()) {
    try {
      const {id, workflow: wf, nodes} = await fetchWorkflow({fresh: true});
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

app.get('/api/schedule', async (_req, res) => {
  try {
    if (n8nConfigured()) {
      const id = await findWorkflowId();
      const wf = await n8nFetch(`/api/v1/workflows/${id}`);
      const node = findScheduleNode(wf);
      const cron = cronFromNode(node);
      const nextRun = wf.active ? nextCronOccurrence(cron, new Date(), SCHEDULE_TIMEZONE) : null;
      return res.json({
        cron,
        source: 'n8n',
        active: wf.active,
        timezone: SCHEDULE_TIMEZONE,
        nextRunAt: nextRun?.toISOString() ?? null,
        nextRunLabel: nextRun ? formatScheduledRun(nextRun, SCHEDULE_TIMEZONE) : null,
      });
    }
    const cron = await readLocalScheduleFile();
    const nextRun = nextCronOccurrence(cron, new Date(), SCHEDULE_TIMEZONE);
    res.json({
      cron,
      source: 'file',
      timezone: SCHEDULE_TIMEZONE,
      nextRunAt: nextRun?.toISOString() ?? null,
      nextRunLabel: nextRun ? formatScheduledRun(nextRun, SCHEDULE_TIMEZONE) : null,
    });
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.post('/api/schedule', async (req, res) => {
  const {cron} = req.body ?? {};
  if (!validateCron(cron)) return res.status(400).json({error: 'Invalid cron expression — expected 5 space-separated fields.'});
  if (!n8nConfigured()) return res.status(400).json({error: 'N8N_API_KEY not configured — cannot edit the live schedule.'});

  try {
    const id = await findWorkflowId();
    const wf = await n8nFetch(`/api/v1/workflows/${id}`);
    const node = findScheduleNode(wf);
    node.parameters.rule.interval[0].expression = cron;
    await n8nFetch(`/api/v1/workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify({name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {}}),
    });

    let fileWarning = null;
    try { await writeLocalScheduleFile(cron); }
    catch (error) { fileWarning = `Live schedule updated, but failed to sync n8n/workflows/research-and-render-reel.json: ${error.message}`; }

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
    const {id, nodes: workflowNodes} = await fetchWorkflow();
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const list = await n8nFetch(executionListPath(id, cursor));
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

app.post('/api/run', async (_req, res) => {
  if (!n8nConfigured()) {
    return res.status(503).json({error: 'N8N_API_KEY not configured — cannot start the workflow.'});
  }
  if (manualTriggerPending) {
    return res.status(409).json({error: 'A manual start request is already in progress.'});
  }

  manualTriggerPending = true;
  try {
    const workflowId = await findWorkflowId();
    const list = await n8nFetch(executionListPath(workflowId));
    const result = await triggerManualRun(list.data ?? [], () => n8nFetch('/webhook/reel-dashboard-run', {
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
