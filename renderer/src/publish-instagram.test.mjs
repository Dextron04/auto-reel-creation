import test from 'node:test'
import assert from 'node:assert/strict'
import {buildVideoUrl, createContainer, pollUntilFinished, publishContainer, getPermalink, publishToInstagram} from './publish-instagram.mjs'

const fakeResponse = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body})

test('buildVideoUrl joins the public base url and the output filename', () => {
  assert.equal(buildVideoUrl('/output/reel-123.mp4', 'https://media.example.com'), 'https://media.example.com/output/reel-123.mp4')
  assert.equal(buildVideoUrl('/output/reel-123.mp4', 'https://media.example.com/'), 'https://media.example.com/output/reel-123.mp4')
})
test('buildVideoUrl throws when no base url is configured', () => {
  const saved = process.env.PUBLIC_MEDIA_BASE_URL
  delete process.env.PUBLIC_MEDIA_BASE_URL
  try { assert.throws(() => buildVideoUrl('/output/reel-123.mp4'), /PUBLIC_MEDIA_BASE_URL/) }
  finally { if (saved !== undefined) process.env.PUBLIC_MEDIA_BASE_URL = saved }
})

test('createContainer returns the creation id from a successful response', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({url: String(url), init}); return fakeResponse(200, {id: 'creation-1'}) }
  const id = await createContainer({videoUrl: 'https://media.example.com/output/a.mp4', caption: 'hi', accessToken: 'tok', businessAccountId: 'biz-1'}, fetchImpl)
  assert.equal(id, 'creation-1')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/biz-1\/media$/)
  assert.equal(calls[0].init.method, 'POST')
})
test('createContainer throws on a non-2xx Graph API response', async () => {
  const fetchImpl = async () => fakeResponse(400, {error: {message: 'bad token'}})
  await assert.rejects(() => createContainer({videoUrl: 'x', caption: 'x', accessToken: 'x', businessAccountId: 'x'}, fetchImpl), /INSTAGRAM_API_ERROR:400/)
})
test('createContainer throws when the response has no id', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => createContainer({videoUrl: 'x', caption: 'x', accessToken: 'x', businessAccountId: 'x'}, fetchImpl), /INSTAGRAM_CONTAINER_NO_ID/)
})

test('pollUntilFinished resolves as soon as status is FINISHED', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'FINISHED'})
  await pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => { throw new Error('should not sleep') }})
})
test('pollUntilFinished retries while IN_PROGRESS then resolves on FINISHED', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return fakeResponse(200, {status_code: calls < 3 ? 'IN_PROGRESS' : 'FINISHED'}) }
  let slept = 0
  await pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => { slept += 1 }})
  assert.equal(calls, 3)
  assert.equal(slept, 2)
})
test('pollUntilFinished throws on ERROR status', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'ERROR'})
  await assert.rejects(() => pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => {}}), /INSTAGRAM_CONTAINER_ERROR:ERROR/)
})
test('pollUntilFinished throws on EXPIRED status', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'EXPIRED'})
  await assert.rejects(() => pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {sleep: async () => {}}), /INSTAGRAM_CONTAINER_ERROR:EXPIRED/)
})
test('pollUntilFinished throws INSTAGRAM_POLL_TIMEOUT when the budget runs out', async () => {
  const fetchImpl = async () => fakeResponse(200, {status_code: 'IN_PROGRESS'})
  let now = 0
  const realNow = Date.now
  Date.now = () => now
  try {
    await assert.rejects(
      () => pollUntilFinished({creationId: 'c1', accessToken: 'tok'}, fetchImpl, {budgetMs: 100, intervalMs: 10, sleep: async () => { now += 20 }}),
      /INSTAGRAM_POLL_TIMEOUT/
    )
  } finally { Date.now = realNow }
})

test('publishContainer returns the published media id', async () => {
  const fetchImpl = async () => fakeResponse(200, {id: 'media-1'})
  const id = await publishContainer({creationId: 'c1', accessToken: 'tok', businessAccountId: 'biz-1'}, fetchImpl)
  assert.equal(id, 'media-1')
})
test('publishContainer throws when the response has no id', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => publishContainer({creationId: 'c1', accessToken: 'tok', businessAccountId: 'biz-1'}, fetchImpl), /INSTAGRAM_PUBLISH_NO_ID/)
})

test('getPermalink returns the permalink', async () => {
  const fetchImpl = async () => fakeResponse(200, {permalink: 'https://instagram.com/reel/abc'})
  const permalink = await getPermalink({mediaId: 'media-1', accessToken: 'tok'}, fetchImpl)
  assert.equal(permalink, 'https://instagram.com/reel/abc')
})
test('getPermalink throws when the response has no permalink', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => getPermalink({mediaId: 'media-1', accessToken: 'tok'}, fetchImpl), /INSTAGRAM_PERMALINK_MISSING/)
})

test('publishToInstagram runs the full create/poll/publish/permalink chain', async () => {
  process.env.INSTAGRAM_ACCESS_TOKEN = 'tok'
  process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = 'biz-1'
  process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com'
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (String(url).includes('/biz-1/media_publish')) return fakeResponse(200, {id: 'media-1'})
    if (String(url).includes('/biz-1/media')) return fakeResponse(200, {id: 'creation-1'})
    if (String(url).includes('/creation-1')) return fakeResponse(200, {status_code: 'FINISHED'})
    if (String(url).includes('/media-1')) return fakeResponse(200, {permalink: 'https://instagram.com/reel/abc'})
    throw new Error(`unexpected url: ${url}`)
  }
  const result = await publishToInstagram({outputLocation: '/output/reel-1.mp4', caption: 'hi'}, fetchImpl)
  assert.deepEqual(result, {mediaId: 'media-1', permalink: 'https://instagram.com/reel/abc'})
  assert.equal(urls.length, 4)
})
test('publishToInstagram throws INSTAGRAM_NOT_CONFIGURED when env vars are missing', async () => {
  delete process.env.INSTAGRAM_ACCESS_TOKEN
  delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID
  await assert.rejects(() => publishToInstagram({outputLocation: '/output/reel-1.mp4', caption: 'hi'}, async () => fakeResponse(200, {})), /INSTAGRAM_NOT_CONFIGURED/)
})
