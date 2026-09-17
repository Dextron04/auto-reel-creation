import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FRESHNESS_MS = 12 * 60 * 60 * 1000;
const SECRET_KEYS = new Set([
  'authorization', 'authorisation', 'token', 'access_token', 'refresh_token',
  'api_key', 'apikey', 'secret', 'password', 'client_secret', 'headers',
]);

function optionsOf(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return fallback;
}

function safePart(value, name) {
  if (typeof value !== 'string' || !value || !/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`RESEARCH_CACHE_INVALID_${name.toUpperCase()}`);
  }
  return value;
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('RESEARCH_CACHE_INVALID_DATE');
  return date;
}

export function researchCachePath(options, format, now, mediaDir) {
  const input = optionsOf(options, { topicSlug: options, format, now, mediaDir });
  const topicSlug = safePart(input.topicSlug, 'topic');
  const cacheFormat = safePart(input.format, 'format');
  const date = dateValue(input.now);
  const root = input.mediaDir ?? process.env.MEDIA_ROOT ?? '/media';
  return path.join(root, 'research-cache', `${topicSlug}-${cacheFormat}-${date.toISOString().slice(0, 10)}.json`);
}

function sanitize(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) continue;
    const clean = sanitize(nested, seen);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}

function cacheArgs(options, value) {
  if (options && typeof options === 'object' && options.topicSlug) return [options, value];
  throw new Error('RESEARCH_CACHE_OPTIONS_REQUIRED');
}

export async function writeResearchCache(options, value) {
  const [input, payload] = cacheArgs(options, value ?? options?.value ?? options?.data ?? {});
  const file = researchCachePath(input);
  const now = dateValue(input.now);
  const clean = sanitize(payload ?? {});
  const body = JSON.stringify({ ...clean, _researchCache: { cachedAt: now.toISOString() } }, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return file;
}

export async function readResearchCache(options) {
  const file = researchCachePath(options);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const cachedAt = parsed?._researchCache?.cachedAt;
  const timestamp = new Date(cachedAt ?? parsed?.cachedAt ?? parsed?.retrieved_at);
  const now = dateValue(options?.now);
  if (Number.isNaN(timestamp.getTime()) || now.getTime() - timestamp.getTime() < 0 || now.getTime() - timestamp.getTime() > FRESHNESS_MS) return null;
  if (parsed && typeof parsed === 'object') delete parsed._researchCache;
  return sanitize(parsed);
}

export const RESEARCH_CACHE_FRESHNESS_MS = FRESHNESS_MS;
