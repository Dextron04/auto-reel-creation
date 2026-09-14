#!/usr/bin/env node
// n8n stores workflows in its own database, not on disk — restarting the container
// never picks up changes to n8n/workflows/*.json. This pushes the file's nodes,
// connections, and settings into the live workflow via the n8n API so a deploy
// actually takes effect instead of silently leaving the old broken version running.
import fs from 'node:fs/promises';

const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://127.0.0.1:5678';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const file = process.argv[2] ?? 'n8n/workflows/research-and-render-reel.json';

if (!N8N_API_KEY) {
  console.log(`N8N_API_KEY not set — skipping n8n workflow sync for ${file}.`);
  process.exit(0);
}

async function n8nFetch(path, opts = {}) {
  const res = await fetch(`${N8N_BASE_URL}${path}`, {
    ...opts,
    headers: {'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json', ...opts.headers},
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`N8N_API_ERROR:${res.status}:${body?.message ?? 'unknown'}`);
  return body;
}

const workflow = JSON.parse(await fs.readFile(file, 'utf8'));

const list = await n8nFetch('/api/v1/workflows?limit=250');
const match = (list.data ?? []).find(w => w.name === workflow.name);
if (!match) {
  console.warn(`n8n workflow "${workflow.name}" not found — import it once via the n8n UI first, then future syncs will work.`);
  process.exit(0);
}

await n8nFetch(`/api/v1/workflows/${match.id}`, {
  method: 'PUT',
  body: JSON.stringify({name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings ?? {}}),
});

console.log(`Synced ${file} to n8n workflow ${match.id} ("${workflow.name}").`);
