import path from 'node:path'

const GRAPH_VERSION = () => process.env.INSTAGRAM_GRAPH_API_VERSION || 'v21.0'
const graphBase = () => `https://graph.facebook.com/${GRAPH_VERSION()}`
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_POLL_BUDGET_MS = 150000

export function buildVideoUrl(outputLocation, baseUrl = process.env.PUBLIC_MEDIA_BASE_URL) {
  if (!baseUrl) throw new Error('PUBLIC_MEDIA_BASE_URL not configured')
  return `${baseUrl.replace(/\/$/, '')}/output/${path.basename(outputLocation)}`
}

async function graphRequest(fetchImpl, method, urlPath, params) {
  const url = new URL(`${graphBase()}${urlPath}`)
  const body = new URLSearchParams(params)
  if (method === 'GET') { for (const [key, value] of body) url.searchParams.set(key, value) }
  const response = await fetchImpl(url, method === 'GET' ? {method} : {method, body})
  const json = await response.json()
  if (!response.ok || json.error) throw new Error(`INSTAGRAM_API_ERROR:${response.status}:${json.error?.message || 'unknown'}`)
  return json
}

export async function createContainer({videoUrl, caption, accessToken, businessAccountId}, fetchImpl = fetch) {
  const json = await graphRequest(fetchImpl, 'POST', `/${businessAccountId}/media`, {media_type: 'REELS', video_url: videoUrl, caption, access_token: accessToken})
  if (!json.id) throw new Error('INSTAGRAM_CONTAINER_NO_ID')
  return json.id
}

export async function pollUntilFinished({creationId, accessToken}, fetchImpl = fetch, {intervalMs = DEFAULT_POLL_INTERVAL_MS, budgetMs = DEFAULT_POLL_BUDGET_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))} = {}) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const json = await graphRequest(fetchImpl, 'GET', `/${creationId}`, {fields: 'status_code', access_token: accessToken})
    if (json.status_code === 'FINISHED') return
    if (json.status_code === 'ERROR' || json.status_code === 'EXPIRED') throw new Error(`INSTAGRAM_CONTAINER_ERROR:${json.status_code}`)
    if (Date.now() >= deadline) throw new Error('INSTAGRAM_POLL_TIMEOUT')
    await sleep(intervalMs)
  }
}

export async function publishContainer({creationId, accessToken, businessAccountId}, fetchImpl = fetch) {
  const json = await graphRequest(fetchImpl, 'POST', `/${businessAccountId}/media_publish`, {creation_id: creationId, access_token: accessToken})
  if (!json.id) throw new Error('INSTAGRAM_PUBLISH_NO_ID')
  return json.id
}

export async function getPermalink({mediaId, accessToken}, fetchImpl = fetch) {
  const json = await graphRequest(fetchImpl, 'GET', `/${mediaId}`, {fields: 'permalink', access_token: accessToken})
  if (!json.permalink) throw new Error('INSTAGRAM_PERMALINK_MISSING')
  return json.permalink
}

export async function publishToInstagram({outputLocation, caption}, fetchImpl = fetch) {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID
  if (!accessToken || !businessAccountId) throw new Error('INSTAGRAM_NOT_CONFIGURED')
  const videoUrl = buildVideoUrl(outputLocation)
  const creationId = await createContainer({videoUrl, caption, accessToken, businessAccountId}, fetchImpl)
  await pollUntilFinished({creationId, accessToken}, fetchImpl)
  const mediaId = await publishContainer({creationId, accessToken, businessAccountId}, fetchImpl)
  const permalink = await getPermalink({mediaId, accessToken}, fetchImpl)
  return {mediaId, permalink}
}
