import fs from 'node:fs/promises';
import path from 'node:path';

const defaultPath = () => path.join(process.env.MEDIA_ROOT ?? '/media', 'topic-history.json');

const GENERIC_NAME_WORDS = new Set(['a', 'an', 'the', 'new', 'tool', 'tools', 'platform', 'layer']);
const GENERIC_TOPIC_WORDS = new Set([
  ...GENERIC_NAME_WORDS,
  'adds', 'added', 'announces', 'for', 'from', 'gives', 'introduces', 'launches', 'release',
  'released', 'ships', 'support', 'supports', 'update', 'with',
]);

function words(value, ignored = new Set()) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignored.has(word));
}

function canonicalName(value) {
  return words(value, GENERIC_NAME_WORDS).join(' ');
}

function containsName(left, right) {
  const leftTokens = left.split(' ').filter(Boolean);
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  return leftTokens.length >= 2 && leftTokens.every((token) => rightTokens.has(token));
}

function overlap(left, right) {
  const a = new Set(words(left, GENERIC_TOPIC_WORDS));
  const b = new Set(words(right, GENERIC_TOPIC_WORDS));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export function isTopicUsed(candidate, history) {
  const candidateName = canonicalName(candidate?.tool_name);
  const candidateTopic = String(candidate?.topic ?? '').trim();
  return (Array.isArray(history) ? history : []).some((entry) => {
    const previousName = canonicalName(entry?.tool_name);
    const sameTool = candidateName && previousName && (
      candidateName === previousName
      || containsName(candidateName, previousName)
      || containsName(previousName, candidateName)
    );
    return sameTool || overlap(candidateTopic, entry?.topic) >= 0.7;
  });
}

export function selectUnusedTopic(research, history) {
  const choices = [research?.recommended_topic, ...(Array.isArray(research?.candidates) ? research.candidates : [])]
    .filter((candidate, index, all) => (
      candidate
      && String(candidate.tool_name ?? '').trim()
      && String(candidate.topic ?? '').trim()
      && Array.isArray(candidate.claims)
      && candidate.claims.length
      && all.indexOf(candidate) === index
    ));
  const selected = choices.find((candidate) => !isTopicUsed(candidate, history));
  if (!selected) throw new Error('TOPIC_HISTORY_ALL_CANDIDATES_USED');
  return {...research, recommended_topic: selected};
}

export async function readTopicHistory(historyPath = defaultPath()) {
  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('TOPIC_HISTORY_INVALID');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error?.message === 'TOPIC_HISTORY_INVALID') throw error;
    throw new Error('TOPIC_HISTORY_INVALID', {cause: error});
  }
}

export async function recordTopic({tool_name, category, topic}, historyPath = defaultPath()) {
  const toolName = String(tool_name ?? '').trim();
  if (!toolName) throw new Error('TOPIC_HISTORY_TOOL_NAME_REQUIRED');
  const history = await readTopicHistory(historyPath);
  const entry = {tool_name: toolName, category: String(category ?? '').trim(), topic: String(topic ?? '').trim(), recommended_at: new Date().toISOString()};
  if (isTopicUsed(entry, history)) throw new Error('TOPIC_HISTORY_DUPLICATE');
  history.push(entry);
  const temporaryPath = `${historyPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(history, null, 2));
  await fs.rename(temporaryPath, historyPath);
  return history;
}
