import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from './server.mjs';

async function withServer(dependencies, callback) {
  const server = createApp(dependencies).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const {port} = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withMediaRoot(callback) {
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'distribution-api-'));
  const previous = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRoot;
  try {
    return await callback(mediaRoot);
  } finally {
    if (previous === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = previous;
  }
}

async function requestJson(base, pathname, {method = 'GET', body} = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? {'content-type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }
  return {status: response.status, body: parsed};
}

test('GET /v1/distribution/weights returns all 10 arms uniformly weighted before any analysis has run', async () => {
  await withMediaRoot(async () => {
    await withServer({}, async (base) => {
      const result = await requestJson(base, '/v1/distribution/weights');
      assert.equal(result.status, 200);
      assert.equal(result.body.weights.length, 10);
      assert.equal(result.body.updatedAt, null);
      for (const arm of result.body.weights) assert.ok(Math.abs(arm.weight - 0.1) < 1e-9);
    });
  });
});

test('POST /v1/distribution/publish-event rejects an unknown topic slug', async () => {
  await withMediaRoot(async () => {
    await withServer({}, async (base) => {
      const result = await requestJson(base, '/v1/distribution/publish-event', {method: 'POST', body: {topicSlug: 'nope', format: 'tips', mediaId: '1'}});
      assert.equal(result.status, 400);
      assert.match(result.body.error, /DISTRIBUTION_LOG_UNKNOWN_TOPIC/);
    });
  });
});

test('POST /v1/distribution/analyze with no publish events yet leaves weights uniform and still writes a report', async () => {
  await withMediaRoot(async () => {
    await withServer({}, async (base) => {
      const result = await requestJson(base, '/v1/distribution/analyze', {method: 'POST', body: {date: '2026-09-18'}});
      assert.equal(result.status, 200);
      assert.equal(result.body.weightsChanged, false);
      assert.equal(result.body.skipReason, 'INSUFFICIENT_SAMPLES');
      const report = await requestJson(base, '/v1/distribution/report?date=2026-09-18');
      assert.equal(report.status, 200);
      assert.equal(report.body.date, '2026-09-18');
    });
  });
});

test('end to end: publish events -> analyze with injected insights -> weights shift towards the better performer -> narrative attaches', async () => {
  await withMediaRoot(async () => {
    const insights = {
      'good-1': {likes: 400, comments: 20, shares: 10, saved: 30, reach: 2000},
      'good-2': {likes: 380, comments: 25, shares: 12, saved: 28, reach: 2000},
      'bad-1': {likes: 5, comments: 0, shares: 0, saved: 0, reach: 2000},
      'bad-2': {likes: 4, comments: 1, shares: 0, saved: 0, reach: 2000},
    };
    let emailedTo;
    let emailedText;
    await withServer({
      fetchMediaInsights: async ({mediaId}) => insights[mediaId] ?? {},
      sendDistributionEmail: async ({report}) => { emailedTo = 'injected'; emailedText = report.narrative; return {sent: true, messageId: 'test'}; },
    }, async (base) => {
      await requestJson(base, '/v1/distribution/publish-event', {method: 'POST', body: {topicSlug: 'git-cli', format: 'tips', mediaId: 'good-1', permalink: 'https://instagram.com/p/1'}});
      await requestJson(base, '/v1/distribution/publish-event', {method: 'POST', body: {topicSlug: 'git-cli', format: 'tips', mediaId: 'good-2', permalink: 'https://instagram.com/p/2'}});
      await requestJson(base, '/v1/distribution/publish-event', {method: 'POST', body: {topicSlug: 'editor-ide', format: 'tips', mediaId: 'bad-1', permalink: 'https://instagram.com/p/3'}});
      await requestJson(base, '/v1/distribution/publish-event', {method: 'POST', body: {topicSlug: 'editor-ide', format: 'tips', mediaId: 'bad-2', permalink: 'https://instagram.com/p/4'}});

      const analyzed = await requestJson(base, '/v1/distribution/analyze', {method: 'POST', body: {date: '2026-09-18'}});
      assert.equal(analyzed.status, 200);
      assert.equal(analyzed.body.weightsChanged, true);
      assert.equal(analyzed.body.topPerformer.slug, 'git-cli');
      assert.equal(analyzed.body.bottomPerformer.slug, 'editor-ide');
      assert.deepEqual(analyzed.body.warnings, []);

      const weights = await requestJson(base, '/v1/distribution/weights');
      const gitCli = weights.body.weights.find((a) => a.slug === 'git-cli' && a.format === 'tips');
      const editorIde = weights.body.weights.find((a) => a.slug === 'editor-ide' && a.format === 'tips');
      assert.ok(gitCli.weight > 0.1, 'the arm with real engagement should now be favored over the cold-start uniform weight');
      assert.ok(editorIde.weight < 0.1);

      const narrated = await requestJson(base, '/v1/distribution/report/narrative', {method: 'POST', body: {date: '2026-09-18', narrative: 'Git & CLI Tricks: Tips pulled far more engagement today.'}});
      assert.equal(narrated.status, 200);
      assert.equal(narrated.body.narrative, 'Git & CLI Tricks: Tips pulled far more engagement today.');

      const report = await requestJson(base, '/v1/distribution/report?date=2026-09-18');
      assert.equal(report.body.narrative, 'Git & CLI Tricks: Tips pulled far more engagement today.');

      const emailed = await requestJson(base, '/v1/distribution/report/email', {method: 'POST', body: {date: '2026-09-18'}});
      assert.equal(emailed.status, 200);
      assert.equal(emailed.body.sent, true);
      assert.equal(emailedTo, 'injected');
      assert.equal(emailedText, 'Git & CLI Tricks: Tips pulled far more engagement today.', 'the emailed report must carry the already-attached narrative, not regenerate one');
    });
  });
});

test('POST /v1/distribution/report/email surfaces a clean error when SMTP is not configured', async () => {
  await withMediaRoot(async () => {
    await withServer({}, async (base) => {
      await requestJson(base, '/v1/distribution/analyze', {method: 'POST', body: {date: '2026-09-18'}});
      const previousTo = process.env.DISTRIBUTION_REPORT_EMAIL_TO;
      delete process.env.DISTRIBUTION_REPORT_EMAIL_TO;
      try {
        const result = await requestJson(base, '/v1/distribution/report/email', {method: 'POST', body: {date: '2026-09-18'}});
        assert.equal(result.status, 400);
        assert.match(result.body.error, /DISTRIBUTION_EMAIL_NOT_CONFIGURED/);
      } finally {
        if (previousTo === undefined) delete process.env.DISTRIBUTION_REPORT_EMAIL_TO;
        else process.env.DISTRIBUTION_REPORT_EMAIL_TO = previousTo;
      }
    });
  });
});

test('POST /v1/distribution/report/email for a date with no report yet returns a clean 400', async () => {
  await withMediaRoot(async () => {
    await withServer({sendDistributionEmail: async () => ({sent: true, messageId: 'unused'})}, async (base) => {
      const result = await requestJson(base, '/v1/distribution/report/email', {method: 'POST', body: {date: '2000-01-01'}});
      assert.equal(result.status, 400);
      assert.match(result.body.error, /DISTRIBUTION_REPORT_NOT_FOUND/);
    });
  });
});

test('POST /v1/distribution/analyze reports INSTAGRAM_NOT_CONFIGURED when publish events exist but no access token is available', async () => {
  await withMediaRoot(async () => {
    const previousToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    try {
      await withServer({}, async (base) => {
        await requestJson(base, '/v1/distribution/publish-event', {method: 'POST', body: {topicSlug: 'git-cli', format: 'tips', mediaId: 'x'}});
        const result = await requestJson(base, '/v1/distribution/analyze', {method: 'POST', body: {}});
        assert.equal(result.status, 400);
        assert.match(result.body.error, /INSTAGRAM_NOT_CONFIGURED/);
      });
    } finally {
      if (previousToken === undefined) delete process.env.INSTAGRAM_ACCESS_TOKEN;
      else process.env.INSTAGRAM_ACCESS_TOKEN = previousToken;
    }
  });
});

test('GET /v1/distribution/report for a date with no report yet returns a clean 400, not a raw filesystem error', async () => {
  await withMediaRoot(async () => {
    await withServer({}, async (base) => {
      const result = await requestJson(base, '/v1/distribution/report?date=2000-01-01');
      assert.equal(result.status, 400);
      assert.match(result.body.error, /DISTRIBUTION_REPORT_NOT_FOUND/);
    });
  });
});
