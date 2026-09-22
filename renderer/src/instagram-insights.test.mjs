import test from 'node:test'
import assert from 'node:assert/strict'
import {fetchMediaInsights, INSIGHT_METRICS} from './instagram-insights.mjs'

function fakeFetch(handler) {
  return async (url, opts) => handler(new URL(url), opts)
}

test('fetchMediaInsights requires a mediaId and an access token', async () => {
  await assert.rejects(() => fetchMediaInsights({accessToken: 't'}), /INSTAGRAM_INSIGHTS_MEDIA_ID_REQUIRED/)
  await assert.rejects(() => fetchMediaInsights({mediaId: '123'}), /INSTAGRAM_NOT_CONFIGURED/)
})

test('fetchMediaInsights requests every configured metric and flattens lifetime values by name', async () => {
  let requestedMetrics
  const fetchImpl = fakeFetch((url) => {
    requestedMetrics = url.searchParams.get('metric');
    assert.equal(url.pathname, '/v21.0/17895695668004550/insights')
    assert.equal(url.searchParams.get('access_token'), 'tok')
    return {
      ok: true,
      json: async () => ({data: [
        {name: 'reach', period: 'lifetime', values: [{value: 4200}]},
        {name: 'likes', period: 'lifetime', values: [{value: 310}]},
        {name: 'comments', period: 'lifetime', values: [{value: 12}]},
        {name: 'shares', period: 'lifetime', values: [{value: 8}]},
        {name: 'saved', period: 'lifetime', values: [{value: 55}]},
        {name: 'total_interactions', period: 'lifetime', values: [{value: 385}]},
      ]}),
    }
  })
  const insights = await fetchMediaInsights({mediaId: '17895695668004550', accessToken: 'tok'}, fetchImpl)
  assert.equal(requestedMetrics, INSIGHT_METRICS.join(','))
  assert.deepEqual(insights, {reach: 4200, likes: 310, comments: 12, shares: 8, saved: 55, total_interactions: 385})
})

test('fetchMediaInsights ignores metrics with no numeric value instead of throwing', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({data: [{name: 'reach', values: [{value: 100}]}, {name: 'saved', values: []}]}),
  }))
  const insights = await fetchMediaInsights({mediaId: '1', accessToken: 't'}, fetchImpl)
  assert.deepEqual(insights, {reach: 100})
})

test('fetchMediaInsights surfaces a Graph API error response', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 400,
    json: async () => ({error: {message: 'Unsupported get request.'}}),
  }))
  await assert.rejects(
    () => fetchMediaInsights({mediaId: 'bad', accessToken: 't'}, fetchImpl),
    /INSTAGRAM_API_ERROR:400:Unsupported get request\./,
  )
})
