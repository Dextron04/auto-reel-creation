import path from 'node:path'
import {readFile, stat} from 'node:fs/promises'
import {OUTPUT_ROOT} from './validation.mjs'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'
const TITLE_MAX_LENGTH = 100

function truncateTitle(raw) {
  const chars = [...raw]
  return chars.length > TITLE_MAX_LENGTH ? `${chars.slice(0, TITLE_MAX_LENGTH - 1).join('').trimEnd()}…` : raw
}

export function buildTitle(topic = {}) {
  const raw = `${topic.tool_name ?? topic.topic ?? 'AI Tool'}: ${topic.hook ?? ''}`.trim()
  return truncateTitle(raw)
}

export function buildDescription(caption) {
  const text = String(caption ?? '').trim()
  return /#shorts/i.test(text) ? text : `${text}\n\n#Shorts`.trim()
}

export function buildShortsUrl(videoId) {
  return `https://youtube.com/shorts/${videoId}`
}

export function resolveOutputPath(outputLocation) {
  return path.join(OUTPUT_ROOT, path.basename(outputLocation))
}

export async function refreshAccessToken({clientId, clientSecret, refreshToken}, fetchImpl = fetch) {
  const body = new URLSearchParams({client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token'})
  const response = await fetchImpl(TOKEN_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body})
  const json = await response.json().catch(() => ({}))
  if (!response.ok || !json.access_token) throw new Error(`YOUTUBE_TOKEN_ERROR:${response.status}:${json.error_description || json.error || 'unknown'}`)
  return json.access_token
}

export async function initiateUpload({accessToken, title, description, privacyStatus, fileSizeBytes}, fetchImpl = fetch) {
  const response = await fetchImpl(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(fileSizeBytes),
    },
    body: JSON.stringify({snippet: {title, description, tags: ['Shorts']}, status: {privacyStatus, selfDeclaredMadeForKids: false}}),
  })
  if (!response.ok) {
    const json = await response.json().catch(() => ({}))
    throw new Error(`YOUTUBE_API_ERROR:${response.status}:${json.error?.message || 'unknown'}`)
  }
  const location = response.headers.get('location')
  if (!location) throw new Error('YOUTUBE_UPLOAD_SESSION_MISSING')
  return location
}

export async function uploadVideoBytes({uploadUrl, videoBuffer}, fetchImpl = fetch) {
  const response = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {'Content-Type': 'video/mp4', 'Content-Length': String(videoBuffer.length)},
    body: videoBuffer,
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok || !json.id) throw new Error(`YOUTUBE_UPLOAD_ERROR:${response.status}:${json.error?.message || 'no id returned'}`)
  return json.id
}

export async function publishToYouTube({outputLocation, title, description}, fetchImpl = fetch, fsImpl = {readFile, stat}) {
  const clientId = process.env.YOUTUBE_CLIENT_ID
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) throw new Error('YOUTUBE_NOT_CONFIGURED')
  const accessToken = await refreshAccessToken({clientId, clientSecret, refreshToken}, fetchImpl)
  const videoPath = resolveOutputPath(outputLocation)
  const {size: fileSizeBytes} = await fsImpl.stat(videoPath)
  const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'public'
  const videoTitle = truncateTitle(String(title ?? ''))
  const videoDescription = buildDescription(description)
  const uploadUrl = await initiateUpload({accessToken, title: videoTitle, description: videoDescription, privacyStatus, fileSizeBytes}, fetchImpl)
  const videoBuffer = await fsImpl.readFile(videoPath)
  const videoId = await uploadVideoBytes({uploadUrl, videoBuffer}, fetchImpl)
  return {videoId, url: buildShortsUrl(videoId)}
}
