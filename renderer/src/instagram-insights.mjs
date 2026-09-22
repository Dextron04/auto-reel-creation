import {graphRequest} from './publish-instagram.mjs'

// Reels-eligible lifetime metrics as of Graph API v21+. Kept as a plain list (not an env override)
// because a metric rename from Meta needs a code change anyway to update the engagement-rate math
// that reads these field names -- an env var here would just be one more thing to keep in sync.
export const INSIGHT_METRICS = ['reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions']

export async function fetchMediaInsights({mediaId, accessToken}, fetchImpl = fetch) {
  if (!mediaId) throw new Error('INSTAGRAM_INSIGHTS_MEDIA_ID_REQUIRED')
  if (!accessToken) throw new Error('INSTAGRAM_NOT_CONFIGURED')
  const json = await graphRequest(fetchImpl, 'GET', `/${mediaId}/insights`, {metric: INSIGHT_METRICS.join(','), access_token: accessToken})
  const values = {}
  for (const item of Array.isArray(json.data) ? json.data : []) {
    const value = item?.values?.[0]?.value
    if (typeof value === 'number') values[item.name] = value
  }
  return values
}
