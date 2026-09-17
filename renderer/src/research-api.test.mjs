import test from 'node:test';
import assert from 'node:assert/strict';
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

async function request(base, pathname, body, {raw = false} = {}) {
  const payload = raw ? body : JSON.stringify(body);
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: payload,
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* express may return an HTML error page */ }
  return {status: response.status, body: parsed};
}

test('research sources rejects unknown topic and format before retrieval', async () => {
  let calls = 0;
  await withServer({
    retrieveResearchSources: async () => { calls += 1; return {status: 'ready'}; },
  }, async (base) => {
    const unknownTopic = await request(base, '/v1/research/sources', {topicSlug: 'unknown', format: 'tips'});
    assert.equal(unknownTopic.status, 400);
    assert.match(unknownTopic.body.error, /RESEARCH_TOPIC_UNKNOWN/);

    const unknownFormat = await request(base, '/v1/research/sources', {topicSlug: 'editor-ide', format: 'unknown'});
    assert.equal(unknownFormat.status, 400);
    assert.match(unknownFormat.body.error, /RESEARCH_FORMAT_INVALID/);
    assert.equal(calls, 0);
  });
});

test('research sources returns ready and no_in_scope_research as successful outcomes', async () => {
  const outcomes = [
    {status: 'ready', topicSlug: 'editor-ide', format: 'tips', sources: [{source_url: 'https://code.visualstudio.com/docs'}], diagnostics: {}},
    {status: 'no_in_scope_research', topicSlug: 'editor-ide', format: 'tips', sources: [], diagnostics: {}, reason: 'shortage'},
  ];
  let call = 0;
  await withServer({
    retrieveResearchSources: async (input) => {
      assert.equal(input.topicSlug, 'editor-ide');
      assert.equal(input.format, 'tips');
      assert.deepEqual(input.recentTopics, []);
      assert.equal(typeof input.classifyBorderline, 'function');
      return outcomes[call++];
    },
  }, async (base) => {
    const ready = await request(base, '/v1/research/sources', {topicSlug: 'editor-ide', format: 'tips', recentTopics: [], now: 'caller-controlled', scope: 'must-ignore'});
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, outcomes[0]);
    const empty = await request(base, '/v1/research/sources', {topicSlug: 'editor-ide', format: 'tips'});
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, outcomes[1]);
  });
});

test('retrieval infrastructure failures map to 502', async () => {
  await withServer({
    retrieveResearchSources: async () => { throw new Error('SEARXNG_HTTP_ERROR:503'); },
  }, async (base) => {
    const result = await request(base, '/v1/research/sources', {topicSlug: 'editor-ide', format: 'tips'});
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, {error: 'SEARXNG_HTTP_ERROR:503'});
  });
});

test('research validation returns 422 with reasons and 200 while preserving valid payload', async () => {
  const invalid = {valid: false, failureCode: 'MISSING_REQUIRED_FIELD', reasons: ['MISSING_REQUIRED_FIELD:hook'], diagnostics: {}};
  const valid = {valid: true, research: {recommended_topic: {topic: 'VS Code'}}, diagnostics: {}, reasons: []};
  let call = 0;
  await withServer({
    validateResearchPackage: async (input) => {
      assert.equal(input.topicSlug, 'editor-ide');
      assert.equal(input.format, 'tips');
      assert.deepEqual(input.evidence, [{source_url: 'https://code.visualstudio.com/docs'}]);
      assert.deepEqual(input.research, {recommended_topic: {topic: 'VS Code'}, candidates: []});
      assert.equal(typeof input.classifyCandidate, 'function');
      return call++ === 0 ? invalid : valid;
    },
    classifyResearchItems: async () => [],
  }, async (base) => {
    const body = {topicSlug: 'editor-ide', format: 'tips', evidence: [{source_url: 'https://code.visualstudio.com/docs'}], research: {recommended_topic: {topic: 'VS Code'}, candidates: []}};
    const first = await request(base, '/v1/research/validate', body);
    assert.equal(first.status, 422);
    assert.deepEqual(first.body, invalid);
    const second = await request(base, '/v1/research/validate', body);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, valid);
  });
});

test('validation rejects unknown topic or format as 400', async () => {
  let calls = 0;
  await withServer({validateResearchPackage: async () => { calls += 1; return {valid: true}; }}, async (base) => {
    const unknownTopic = await request(base, '/v1/research/validate', {topicSlug: 'unknown', format: 'tips', evidence: [], research: {}});
    assert.equal(unknownTopic.status, 400);
    const unknownFormat = await request(base, '/v1/research/validate', {topicSlug: 'editor-ide', format: 'unknown', evidence: [], research: {}});
    assert.equal(unknownFormat.status, 400);
    assert.equal(calls, 0);
  });
});

test('research record writes return a path and outcome', async () => {
  await withServer({
    writeResearchRecord: async (input) => {
      assert.deepEqual(input, {runId: 'run-1', record: {status: 'ready'}});
      return '/media/research-runs/run-1.json';
    },
  }, async (base) => {
    const result = await request(base, '/v1/research/record', {runId: 'run-1', record: {status: 'ready'}});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {path: '/media/research-runs/run-1.json', outcome: 'recorded'});
  });
});

test('research record input errors map to 400 and storage failures to 502', async () => {
  await withServer({
    writeResearchRecord: async () => { throw new Error('RESEARCH_RECORD_RUN_ID_INVALID'); },
  }, async (base) => {
    const inputError = await request(base, '/v1/research/record', {runId: '../escape', record: {}});
    assert.equal(inputError.status, 400);
    assert.match(inputError.body.error, /RESEARCH_RECORD_RUN_ID_INVALID/);
  });
  await withServer({
    writeResearchRecord: async () => { throw new Error('EACCES'); },
  }, async (base) => {
    const storageError = await request(base, '/v1/research/record', {runId: 'run-1', record: {}});
    assert.equal(storageError.status, 502);
    assert.equal(storageError.body.error, 'EACCES');
  });
});

test('the existing 256 KB JSON body limit remains enforced', async () => {
  await withServer({retrieveResearchSources: async () => ({status: 'ready'})}, async (base) => {
    const oversized = await request(base, '/v1/research/sources', JSON.stringify({topicSlug: 'editor-ide', format: 'tips', padding: 'x'.repeat(300 * 1024)}), {raw: true});
    assert.equal(oversized.status, 413);
    assert.deepEqual(oversized.body, {error: 'REQUEST_BODY_TOO_LARGE'});
  });
});

test('health route remains available when server is imported for testing', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {ready: true, renderer: 'remotion', canvas: '1080x1920'});
  });
});
