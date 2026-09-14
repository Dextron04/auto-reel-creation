import express from 'express';
import {renderReel} from './render.mjs';
import {discoverVisuals} from './asset-discovery.mjs';
import {publishToInstagram} from './publish-instagram.mjs';
import {readTopicHistory, recordTopic, selectUnusedTopic} from './topic-history.mjs';

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
app.listen(process.env.PORT ?? 3001, '0.0.0.0', () => console.log('renderer listening on 3001'));
