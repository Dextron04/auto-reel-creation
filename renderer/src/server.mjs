import express from 'express';
import {renderReel} from './render.mjs';
import {discoverVisuals} from './asset-discovery.mjs';

const app = express();
app.use(express.json({limit: '256kb'}));
app.use('/media', express.static(process.env.MEDIA_ROOT ?? '/media', {dotfiles: 'deny', fallthrough: false}));
app.get('/health', (_req, res) => res.json({ready: true, renderer: 'remotion', canvas: '1080x1920'}));
app.post('/v1/visuals', async (req, res) => {
  try {res.json(await discoverVisuals(req.body));}
  catch (error) {res.status(400).json({error:error.message});}
});
app.post('/v1/render', async (req, res) => {
  try { res.status(202).json(await renderReel(req.body)); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.listen(process.env.PORT ?? 3001, '0.0.0.0', () => console.log('renderer listening on 3001'));
