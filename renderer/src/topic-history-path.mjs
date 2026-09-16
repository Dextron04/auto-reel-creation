import path from 'node:path';

const MEDIA_ROOT = process.env.MEDIA_ROOT ?? '/media';
const NAMESPACE_PATTERN = /^[a-z0-9-]{1,40}$/;

// Separate content pipelines (tool-trend reels vs. developer-tips reels) must not exclude each
// other's rendered topics — a "namespace" picks a distinct history file so their dedup memory
// stays independent. Restricted to a small charset so it can never escape MEDIA_ROOT.
export function topicHistoryPath(namespace) {
  if (namespace == null || namespace === '') return path.join(MEDIA_ROOT, 'topic-history.json');
  if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) throw new Error('TOPIC_HISTORY_INVALID_NAMESPACE');
  return path.join(MEDIA_ROOT, `topic-history.${namespace}.json`);
}
