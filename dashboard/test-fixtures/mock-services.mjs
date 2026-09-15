import express from 'express';
import fs from 'node:fs/promises';

const workflow = JSON.parse(await fs.readFile(new URL('../../n8n/workflows/research-and-render-reel.json', import.meta.url), 'utf8'));
const startedAt = new Date(Date.now() - 94_000).toISOString();
const completedNames = workflow.nodes.slice(0, 17).map(node => node.name);
const runData = Object.fromEntries(completedNames.map((name, index) => [name, [{startTime:Date.now() - 90_000 + index * 1200, executionTime:220 + index * 41}]]));

const execution = {
  id: 'live-preview-51',
  status: 'running',
  mode: 'manual',
  startedAt,
  stoppedAt: null,
  data: {
    resultData: {lastNodeExecuted:'Score Developer Tool Trends', runData},
    executionData: {nodeExecutionStack:[{node:{name:'Find and Download Script Images'}}]},
  },
};

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ready:true, renderer:'remotion', canvas:'1080x1920'}));
app.get('/healthz', (_req, res) => res.json({status:'ok'}));
app.get('/api/v1/workflows', (_req, res) => res.json({data:[{id:'preview-workflow', name:workflow.name, active:true}]}));
app.get('/api/v1/workflows/preview-workflow', (_req, res) => res.json({...workflow, id:'preview-workflow', active:true, updatedAt:new Date().toISOString()}));
app.get('/api/v1/executions', (_req, res) => res.json({data:[{id:execution.id, status:execution.status, mode:execution.mode, startedAt:execution.startedAt, stoppedAt:null}], nextCursor:null}));
app.get('/api/v1/executions/:id', (_req, res) => res.json(execution));
app.post('/webhook/reel-dashboard-run', (_req, res) => res.status(202).json({ok:true}));

const port = Number(process.env.MOCK_PORT ?? 45678);
app.listen(port, () => console.log(`mock services listening on ${port}`));
