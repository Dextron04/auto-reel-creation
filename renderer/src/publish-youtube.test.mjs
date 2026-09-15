import test from 'node:test'
import assert from 'node:assert/strict'
import {buildTitle, buildDescription, buildShortsUrl, refreshAccessToken, initiateUpload, uploadVideoBytes, publishToYouTube} from './publish-youtube.mjs'

const fakeResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: {get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null},
})

test('buildTitle derives a title from the tool name and hook', () => {
  assert.equal(buildTitle({tool_name: 'Agent Kit', hook: 'Stop writing glue code'}), 'Agent Kit: Stop writing glue code')
})
test('buildTitle falls back to topic or a generic label when tool_name is missing', () => {
  assert.equal(buildTitle({topic: 'Agent Kit', hook: 'Stop writing glue code'}), 'Agent Kit: Stop writing glue code')
  assert.equal(buildTitle({hook: 'Stop writing glue code'}), 'AI Tool: Stop writing glue code')
})
test('buildTitle truncates to 100 characters with an ellipsis', () => {
  const hook = 'Stop writing glue code for every coding agent you touch this quarter and beyond, seriously'
  const title = buildTitle({tool_name: 'Agent Kit', hook})
  assert.ok(title.length <= 100)
  assert.ok(title.endsWith('…'))
  assert.ok(title.startsWith('Agent Kit: Stop writing glue code'))
})

test('buildDescription appends #Shorts when missing', () => {
  assert.equal(buildDescription('Stop writing glue code.\n\n#AgentKit #DevTools'), 'Stop writing glue code.\n\n#AgentKit #DevTools\n\n#Shorts')
})
test('buildDescription does not duplicate #Shorts when already present', () => {
  assert.equal(buildDescription('Already has #Shorts in it.'), 'Already has #Shorts in it.')
})

test('buildShortsUrl builds a youtube.com/shorts link', () => {
  assert.equal(buildShortsUrl('abc123'), 'https://youtube.com/shorts/abc123')
})

test('refreshAccessToken returns the access token from a successful response', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({url: String(url), init}); return fakeResponse(200, {access_token: 'tok-1'}) }
  const token = await refreshAccessToken({clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'}, fetchImpl)
  assert.equal(token, 'tok-1')
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token')
  assert.equal(calls[0].init.method, 'POST')
})
test('refreshAccessToken throws on a non-2xx or missing token response', async () => {
  const fetchImpl = async () => fakeResponse(400, {error: 'invalid_grant', error_description: 'Token has been expired or revoked'})
  await assert.rejects(() => refreshAccessToken({clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'}, fetchImpl), /YOUTUBE_TOKEN_ERROR:400:Token has been expired or revoked/)
})

test('initiateUpload returns the resumable session url from the Location header', async () => {
  const fetchImpl = async () => fakeResponse(200, {}, {location: 'https://upload.example.com/session-1'})
  const uploadUrl = await initiateUpload({accessToken: 'tok', title: 't', description: 'd', privacyStatus: 'public', fileSizeBytes: 1024}, fetchImpl)
  assert.equal(uploadUrl, 'https://upload.example.com/session-1')
})
test('initiateUpload throws on a non-2xx response', async () => {
  const fetchImpl = async () => fakeResponse(401, {error: {message: 'invalid credentials'}})
  await assert.rejects(() => initiateUpload({accessToken: 'tok', title: 't', description: 'd', privacyStatus: 'public', fileSizeBytes: 1024}, fetchImpl), /YOUTUBE_API_ERROR:401:invalid credentials/)
})
test('initiateUpload throws when the Location header is missing', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => initiateUpload({accessToken: 'tok', title: 't', description: 'd', privacyStatus: 'public', fileSizeBytes: 1024}, fetchImpl), /YOUTUBE_UPLOAD_SESSION_MISSING/)
})

test('uploadVideoBytes returns the video id from a successful response', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({url: String(url), init}); return fakeResponse(200, {id: 'video-1'}) }
  const videoId = await uploadVideoBytes({uploadUrl: 'https://upload.example.com/session-1', videoBuffer: Buffer.from('fake video bytes')}, fetchImpl)
  assert.equal(videoId, 'video-1')
  assert.equal(calls[0].init.method, 'PUT')
})
test('uploadVideoBytes throws when the response has no id', async () => {
  const fetchImpl = async () => fakeResponse(200, {})
  await assert.rejects(() => uploadVideoBytes({uploadUrl: 'https://upload.example.com/session-1', videoBuffer: Buffer.from('x')}, fetchImpl), /YOUTUBE_UPLOAD_ERROR:200:no id returned/)
})

test('publishToYouTube runs the full refresh/initiate/upload chain', async () => {
  process.env.YOUTUBE_CLIENT_ID = 'id'
  process.env.YOUTUBE_CLIENT_SECRET = 'secret'
  process.env.YOUTUBE_REFRESH_TOKEN = 'refresh'
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (String(url).includes('oauth2.googleapis.com')) return fakeResponse(200, {access_token: 'tok-1'})
    if (String(url).includes('uploadType=resumable')) return fakeResponse(200, {}, {location: 'https://upload.example.com/session-1'})
    if (String(url).includes('session-1')) return fakeResponse(200, {id: 'video-1'})
    throw new Error(`unexpected url: ${url}`)
  }
  const fsImpl = {
    stat: async () => ({size: 1024}),
    readFile: async () => Buffer.from('fake video bytes'),
  }
  const result = await publishToYouTube({outputLocation: '/output/reel-1.mp4', title: 't', description: 'd'}, fetchImpl, fsImpl)
  assert.deepEqual(result, {videoId: 'video-1', url: 'https://youtube.com/shorts/video-1'})
  assert.equal(urls.length, 3)
})
test('publishToYouTube throws YOUTUBE_NOT_CONFIGURED when env vars are missing', async () => {
  delete process.env.YOUTUBE_CLIENT_ID
  delete process.env.YOUTUBE_CLIENT_SECRET
  delete process.env.YOUTUBE_REFRESH_TOKEN
  await assert.rejects(
    () => publishToYouTube(
      {outputLocation: '/output/reel-1.mp4', title: 't', description: 'd'},
      async () => fakeResponse(200, {}),
      {stat: async () => ({size: 1}), readFile: async () => Buffer.from('x')},
    ),
    /YOUTUBE_NOT_CONFIGURED/
  )
})
