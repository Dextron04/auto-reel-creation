import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {topicHistoryPath} from './topic-history-path.mjs';
import {renderReel} from './render.mjs';
import {discoverVisuals} from './asset-discovery.mjs';
import {publishToInstagram, diagnoseInstagramContainer} from './publish-instagram.mjs';
import {publishToYouTube} from './publish-youtube.mjs';
import {readTopicHistory, recordTopic, selectUnusedTopic} from './topic-history.mjs';
import {recordDistributionEvent, readDistributionLog} from './distribution-log.mjs';
import {ARMS, armKey, readWeights, writeWeights, summarizeArmPerformance, computeWeights} from './distribution-weights.mjs';
import {buildDistributionReport, writeDistributionReport, readDistributionReport, attachNarrative} from './distribution-report.mjs';
import {fetchMediaInsights as defaultFetchMediaInsights} from './instagram-insights.mjs';
import {sendDistributionEmail as defaultSendDistributionEmail} from './distribution-email.mjs';
import {discoverTrends} from './trend-discovery.mjs';
import {buildStoryboard, scoreVisual, approveStoryboard} from './visual-preflight.mjs';
import {rankConcepts} from './editorial.mjs';
import {writeEditorialRecord} from './editorial-record.mjs';
import {validateProductionPackage} from './production-gate.mjs';
import {TOPIC_FORMATS, getResearchTopic} from './research-topic-registry.mjs';
import {retrieveResearchSources as defaultRetrieveResearchSources} from './research-sources.mjs';
import {validateResearchPackage as defaultValidateResearchPackage} from './research-package-validator.mjs';
import {classifyResearchItems as defaultClassifyResearchItems} from './research-classifier.mjs';
import {writeResearchRecord as defaultWriteResearchRecord} from './research-record.mjs';

const PUBLIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
function messageOf(error) {
  return error instanceof Error ? error.message : String(error?.message ?? error);
}

function assertResearchRequest({topicSlug, format}) {
  try { getResearchTopic(topicSlug); }
  catch (error) { throw new Error(messageOf(error)); }
  if (!TOPIC_FORMATS.includes(format)) throw new Error(`RESEARCH_FORMAT_INVALID:${format}`);
}

function isResearchInputError(error) {
  const message = messageOf(error);
  return /^(?:RESEARCH_TOPIC_UNKNOWN|RESEARCH_FORMAT_INVALID|INVALID_FORMAT|UNKNOWN_TOPIC|RESEARCH_RECORD_REQUIRED|RESEARCH_RECORD_RUN_ID_INVALID|CLASSIFIER_ITEMS_INVALID|CLASSIFIER_SCOPE_REQUIRED|CLASSIFIER_ITEM_ID_REQUIRED)(?::|$)/.test(message);
}

function classifierFor(classifier, kind) {
  return async (items, context = {}) => {
    const normalizedItems = items.map((item, index) => ({
      id: String(item?.id ?? item?.source_url ?? `${item?.topic ?? 'candidate'}:${item?.tool_name ?? index}`),
      title: item?.title ?? item?.topic ?? item?.tool_name ?? '',
      summary: item?.summary ?? item?.one_line_value ?? item?.developer_workflow ?? '',
    }));
    return classifier({topic: context.topic, items: normalizedItems, kind});
  };
}

export function createApp(dependencies = {}) {
  const retrieveResearchSources = dependencies.retrieveResearchSources
    ?? dependencies.retrieval
    ?? defaultRetrieveResearchSources;
  const validateResearchPackage = dependencies.validateResearchPackage
    ?? dependencies.validator
    ?? defaultValidateResearchPackage;
  const classifyResearchItems = dependencies.classifyResearchItems
    ?? dependencies.classifier
    ?? defaultClassifyResearchItems;
  const writeResearchRecord = dependencies.writeResearchRecord
    ?? dependencies.recordWriter
    ?? defaultWriteResearchRecord;
  const fetchMediaInsights = dependencies.fetchMediaInsights ?? defaultFetchMediaInsights;
  const sendDistributionEmail = dependencies.sendDistributionEmail ?? defaultSendDistributionEmail;

  const app = express();
  app.use(express.json({limit: '256kb'}));
  app.use(express.static(PUBLIC_ROOT, {extensions: ['html'], dotfiles: 'deny'}));
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
  app.post('/v1/editorial/production-gate', (req, res) => {
    const result = validateProductionPackage(req.body ?? {});
    res.status(result.ok ? 200 : 400).json({...req.body, ...result});
  });
  app.post('/v1/publish/instagram', async (req, res) => {
    try { res.json(await publishToInstagram(req.body)); }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/publish/instagram/diagnose', async (req, res) => {
    try { res.json(await diagnoseInstagramContainer(req.body)); }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/publish/youtube', async (req, res) => {
    try { res.json(await publishToYouTube(req.body)); }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.get('/v1/topic-history', async (req, res) => {
    try {
      // A repeated ?namespace= query merges pools that should both steer future research away from
      // a topic (rendered + rejected) without conflating them at the hard render-dedup gate below,
      // which must only ever see the "actually rendered" pool.
      const namespaces = Array.isArray(req.query?.namespace) ? req.query.namespace : [req.query?.namespace];
      const histories = await Promise.all(namespaces.map((namespace) => readTopicHistory(topicHistoryPath(namespace))));
      res.json({recent: histories.flat()});
    }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/topic-history', async (req, res) => {
    try {
      const historyPath = topicHistoryPath(req.body?.namespace);
      res.json({recent: await recordTopic(req.body, historyPath), render: req.body.render});
    }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/topic-history/select', async (req, res) => {
    try {
      const historyPath = topicHistoryPath(req.body?.namespace);
      const history = await readTopicHistory(historyPath);
      res.json({...req.body, research: selectUnusedTopic(req.body?.research, history)});
    }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/distribution/publish-event', async (req, res) => {
    try { res.json({recorded: true, log: await recordDistributionEvent(req.body)}); }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.get('/v1/distribution/weights', async (req, res) => {
    try {
      const {weights, updatedAt} = await readWeights();
      res.json({weights: ARMS.map((arm) => ({...arm, weight: weights[armKey(arm)]})), updatedAt});
    } catch (error) { res.status(400).json({error: error.message}); }
  });
  // Fetches fresh Instagram insights for every logged publish, recomputes per-topic engagement
  // stats and weights (falling back to the previous weights untouched when too few arms have
  // enough samples yet), and writes the day's report -- this is the one call the daily n8n
  // workflow makes; everything else here just exposes its inputs/outputs for that workflow.
  app.post('/v1/distribution/analyze', async (req, res) => {
    try {
      const date = req.body?.date ?? new Date().toISOString().slice(0, 10);
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      const log = await readDistributionLog();
      const {weights: previousWeights} = await readWeights();
      // Only the real Graph API fetcher needs a token -- a caller-injected fetchMediaInsights
      // (tests, or a future alternate source) owns its own auth precondition.
      if (!dependencies.fetchMediaInsights && log.length && !accessToken) throw new Error('INSTAGRAM_NOT_CONFIGURED');
      const warnings = [];
      const insightsByMediaId = {};
      await Promise.all(log.map(async (entry) => {
        try { insightsByMediaId[entry.mediaId] = await fetchMediaInsights({mediaId: entry.mediaId, accessToken}); }
        catch (error) { warnings.push(`${entry.mediaId}: ${error.message}`); }
      }));
      const stats = summarizeArmPerformance({log, insightsByMediaId});
      const weightResult = computeWeights({stats, previousWeights});
      await writeWeights({weights: weightResult.weights, updatedAt: weightResult.updatedAt});
      const report = buildDistributionReport({date, weightResult});
      await writeDistributionReport({date, report});
      res.json({...report, warnings});
    } catch (error) { res.status(400).json({error: error.message}); }
  });
  app.get('/v1/distribution/report', async (req, res) => {
    try { res.json(await readDistributionReport(req.query?.date ?? new Date().toISOString().slice(0, 10))); }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/distribution/report/narrative', async (req, res) => {
    try { res.json(await attachNarrative(req.body)); }
    catch (error) { res.status(400).json({error: error.message}); }
  });
  app.post('/v1/distribution/report/email', async (req, res) => {
    try {
      const date = req.body?.date ?? new Date().toISOString().slice(0, 10);
      const report = await readDistributionReport(date);
      res.json(await sendDistributionEmail({report}));
    } catch (error) { res.status(400).json({error: error.message}); }
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

  app.post('/v1/research/sources', async (req, res) => {
    const {topicSlug, format, recentTopics} = req.body ?? {};
    try {
      assertResearchRequest({topicSlug, format});
      const result = await retrieveResearchSources({
        topicSlug,
        format,
        recentTopics: Array.isArray(recentTopics) ? recentTopics : [],
        classifyBorderline: classifierFor(classifyResearchItems, 'research-source'),
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(isResearchInputError(error) ? 400 : 502).json({error: messageOf(error)});
    }
  });

  app.post('/v1/research/validate', async (req, res) => {
    const {topicSlug, format, evidence, research} = req.body ?? {};
    try {
      assertResearchRequest({topicSlug, format});
      const result = await validateResearchPackage({
        topicSlug,
        format,
        evidence,
        research,
        classifyCandidate: classifierFor(classifyResearchItems, 'research-candidate'),
      });
      res.status(result?.valid === true ? 200 : 422).json(result);
    } catch (error) {
      res.status(isResearchInputError(error) ? 400 : 502).json({error: messageOf(error)});
    }
  });

  app.post('/v1/research/record', async (req, res) => {
    const {runId, record} = req.body ?? {};
    try {
      const pathWritten = await writeResearchRecord({runId, record});
      res.status(200).json({path: pathWritten, outcome: 'recorded'});
    } catch (error) {
      res.status(isResearchInputError(error) ? 400 : 502).json({error: messageOf(error)});
    }
  });
  // Body-parser errors happen before a route handler runs. Handle only the
  // existing JSON size limit here so clients receive a clean API response;
  // all other errors retain Express's established default behavior.
  app.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({error: 'REQUEST_BODY_TOO_LARGE'});
    }
    return next(error);
  });
  return app;
}

const isEntryModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryModule) {
  createApp().listen(process.env.PORT ?? 3001, '0.0.0.0', () => console.log('renderer listening on 3001'));
}
