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

// A second, schedule-less workflow (mirrors a topic worker: dispatched by another workflow's
// Execute Workflow node, never on its own schedule) so the dashboard's workflow selector and its
// "no independent schedule" messaging have something real to switch to and exercise.
const topicWorker = {
  id: 'preview-topic-worker',
  name: 'Preview Topic: Tips Reel',
  active: true,
  updatedAt: new Date().toISOString(),
  nodes: [
    {name: 'When Executed by Round Robin', type: 'n8n-nodes-base.executeWorkflowTrigger', parameters: {}, position: [0, 0]},
    {name: 'Run Topic Tips Reel from Dashboard', type: 'n8n-nodes-base.webhook', parameters: {path: 'topic-preview-tips-run'}, position: [0, 200]},
  ],
  connections: {},
  settings: {},
};

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ready:true, renderer:'remotion', canvas:'1080x1920'}));
app.get('/healthz', (_req, res) => res.json({status:'ok'}));
app.get('/api/v1/workflows', (_req, res) => res.json({data:[
  {id:'preview-workflow', name:workflow.name, active:true},
  {id:topicWorker.id, name:topicWorker.name, active:topicWorker.active},
]}));
app.get('/api/v1/workflows/preview-workflow', (_req, res) => res.json({...workflow, id:'preview-workflow', active:true, updatedAt:new Date().toISOString()}));
app.get('/api/v1/workflows/preview-topic-worker', (_req, res) => res.json(topicWorker));
app.get('/api/v1/executions', (req, res) => {
  if (req.query.workflowId === topicWorker.id) return res.json({data:[], nextCursor:null});
  res.json({data:[{id:execution.id, status:execution.status, mode:execution.mode, startedAt:execution.startedAt, stoppedAt:null}], nextCursor:null});
});
app.get('/api/v1/executions/:id', (_req, res) => res.json(execution));
app.post('/webhook/reel-dashboard-run', (_req, res) => res.status(202).json({ok:true}));
app.post('/webhook/topic-preview-tips-run', (_req, res) => res.status(202).json({ok:true}));

const port = Number(process.env.MOCK_PORT ?? 45678);
app.listen(port, () => console.log(`mock services listening on ${port}`));
