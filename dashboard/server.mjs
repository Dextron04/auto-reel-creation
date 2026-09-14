import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const WORKFLOW_PATH = path.join(ROOT, 'n8n/workflows/research-and-render-reel.json');
const GATES_PATH = path.join(ROOT, 'GATES.md');

const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const RENDERER_BASE_URL = process.env.RENDERER_URL_PUBLIC ?? 'http://localhost:3001';
const PORT = process.env.DASHBOARD_PORT ?? 4000;
const SCHEDULE_NODE_NAME = 'Research Twice Daily';

let cachedWorkflowId = null;

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
  const match = (list.data ?? []).find(w => w.name === 'Research and Render Local AI Reel');
  if (!match) throw new Error('N8N_WORKFLOW_NOT_FOUND');
  cachedWorkflowId = match.id;
  return cachedWorkflowId;
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
      const id = await findWorkflowId();
      const wf = await n8nFetch(`/api/v1/workflows/${id}`);
      workflow = {id, name: wf.name, active: wf.active, updatedAt: wf.updatedAt};
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
      return res.json({cron: cronFromNode(node), source: 'n8n', active: wf.active});
    }
    const cron = await readLocalScheduleFile();
    res.json({cron, source: 'file'});
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

    res.json({ok: true, cron, fileWarning});
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

app.get('/api/executions', async (_req, res) => {
  if (!n8nConfigured()) return res.json({configured: false, recent: []});
  try {
    const id = await findWorkflowId();
    const list = await n8nFetch(`/api/v1/executions?workflowId=${id}&limit=20&includeData=true`);
    const recent = (list.data ?? []).map(exec => ({
      id: exec.id,
      status: exec.status,
      mode: exec.mode,
      startedAt: exec.startedAt,
      stoppedAt: exec.stoppedAt,
      error: exec.status === 'error' ? (exec.data?.resultData?.error?.message ?? 'Unknown error') : null,
      failedNode: exec.status === 'error' ? (exec.data?.resultData?.lastNodeExecuted ?? null) : null,
    }));
    res.json({configured: true, recent});
  } catch (error) { res.status(500).json({configured: true, error: error.message, recent: []}); }
});

app.get('/api/gates', async (_req, res) => {
  try {
    const raw = await fs.readFile(GATES_PATH, 'utf8');
    const gates = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^- \[( |x)\] (G\d+): (.+)$/);
      if (!match) continue;
      let evidence = null;
      for (let j = i + 1; j < Math.min(i + 6, lines.length) && !lines[j].startsWith('- ['); j++) {
        const evMatch = lines[j].match(/^\s*EVIDENCE: (.+)$/);
        if (evMatch) { evidence = evMatch[1]; break; }
      }
      gates.push({id: match[2], done: match[1] === 'x', title: match[3], evidence});
    }
    res.json(gates);
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.listen(PORT, () => console.log(`dashboard listening on ${PORT}`));
