import fs from 'node:fs/promises';
import path from 'node:path';
import {TOPIC_SLUGS, TOPIC_FORMATS} from './research-topic-registry.mjs';

const defaultPath = () => path.join(process.env.MEDIA_ROOT ?? '/media', 'distribution-log.json');

export async function readDistributionLog(logPath = defaultPath()) {
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('DISTRIBUTION_LOG_INVALID');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error?.message === 'DISTRIBUTION_LOG_INVALID') throw error;
    throw new Error('DISTRIBUTION_LOG_INVALID', {cause: error});
  }
}

// One entry per successful Instagram publish -- this is the join key between "what the picker
// dispatched" and "how that specific post actually performed" that the daily analysis reads back.
export async function recordDistributionEvent({topicSlug, format, mediaId, permalink, publishedAt}, logPath = defaultPath()) {
  if (!TOPIC_SLUGS.includes(topicSlug)) throw new Error(`DISTRIBUTION_LOG_UNKNOWN_TOPIC:${topicSlug}`);
  if (!TOPIC_FORMATS.includes(format)) throw new Error(`DISTRIBUTION_LOG_UNKNOWN_FORMAT:${format}`);
  const cleanMediaId = String(mediaId ?? '').trim();
  if (!cleanMediaId) throw new Error('DISTRIBUTION_LOG_MEDIA_ID_REQUIRED');
  const log = await readDistributionLog(logPath);
  const entry = {
    topicSlug,
    format,
    mediaId: cleanMediaId,
    permalink: String(permalink ?? '').trim() || null,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : new Date().toISOString(),
  };
  log.push(entry);
  const temporaryPath = `${logPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(logPath), {recursive: true});
  await fs.writeFile(temporaryPath, JSON.stringify(log, null, 2));
  await fs.rename(temporaryPath, logPath);
  return log;
}
