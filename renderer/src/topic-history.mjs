import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 20;
const defaultPath = () => path.join(process.env.MEDIA_ROOT ?? '/media', 'topic-history.json');

export async function readTopicHistory(historyPath = defaultPath()) {
  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function recordTopic({tool_name, category, topic}, historyPath = defaultPath()) {
  const toolName = String(tool_name ?? '').trim();
  if (!toolName) throw new Error('TOPIC_HISTORY_TOOL_NAME_REQUIRED');
  const history = await readTopicHistory(historyPath);
  history.push({tool_name: toolName, category: String(category ?? '').trim(), topic: String(topic ?? '').trim(), recommended_at: new Date().toISOString()});
  const trimmed = history.slice(-MAX_ENTRIES);
  await fs.writeFile(historyPath, JSON.stringify(trimmed, null, 2));
  return trimmed;
}
