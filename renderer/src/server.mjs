import express from 'express';
import {renderReel} from './render.mjs';
import {discoverVisuals} from './asset-discovery.mjs';
import {publishToInstagram} from './publish-instagram.mjs';
import {readTopicHistory, recordTopic, selectUnusedTopic} from './topic-history.mjs';
import {discoverTrends} from './trend-discovery.mjs';
import {buildStoryboard, scoreVisual, approveStoryboard} from './visual-preflight.mjs';
import {rankConcepts} from './editorial.mjs';
import {writeEditorialRecord} from './editorial-record.mjs';

const app = express();
app.use(express.json({limit: '256kb'}));
app.use('/media', express.static(process.env.MEDIA_ROOT ?? '/media', {dotfiles: 'deny', fallthrough: false}));
app.use('/output', express.static(process.env.OUTPUT_ROOT ?? '/output', {dotfiles: 'deny', fallthrough: false}));
app.get('/health', (_req, res) => res.json({ready: true, renderer: 'remotion', canvas: '1080x1920'}));
app.post('/v1/visuals', async (req, res) => {
  try {res.json(await discoverVisuals(req.body));}
  catch (error) {res.status(400).json({error:error.message});}
});
app.post('/v1/render', async (req, res) => {
  try { res.status(202).json(await renderReel(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/v1/publish/instagram', async (req, res) => {
  try { res.json(await publishToInstagram(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.get('/v1/topic-history', async (_req, res) => {
  try { res.json({recent: await readTopicHistory()}); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/v1/topic-history', async (req, res) => {
  try { res.json({recent: await recordTopic(req.body), render: req.body.render}); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/v1/topic-history/select', async (req, res) => {
  try {
    const history = await readTopicHistory();
    res.json({...req.body, research: selectUnusedTopic(req.body?.research, history)});
  }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.post('/v1/editorial/dry-run', async (req, res) => {
  try {
    const history = await readTopicHistory();
    const discovery = discoverTrends({sources:req.body?.sources ?? [], history, limits:req.body?.limits});
    const concepts = rankConcepts((req.body?.concepts ?? []).map((concept, index) => ({...concept, source_signal_ids:concept.source_signal_ids ?? discovery.signals.slice(index, index + 2).map(signal => signal.signal_id)})));
    if (!concepts.length) throw new Error('EDITORIAL_NO_VALID_CONCEPT');
    const storyboard = buildStoryboard(concepts[0]);
    const inventory = storyboard.map((beat, index) => scoreVisual({assetId:`dry-${index}`, kind:'fixture'}, beat, req.body?.vision ?? {available:true, relevance:4, correctness:4, readability:4, interest:3, distinctness:3}));
    const visualApproval = approveStoryboard(inventory);
    const runId = String(req.body?.runId ?? `dry-${Date.now()}`);
    const recordPath = await writeEditorialRecord({runId, artifact:{discovery, concepts, storyboard, visual_inventory:visualApproval, dry_run:true}});
    res.json({runId, discovery, concepts, visualApproval, recordPath});
  } catch (error) { res.status(400).json({error:error.message}); }
});
app.listen(process.env.PORT ?? 3001, '0.0.0.0', () => console.log('renderer listening on 3001'));
