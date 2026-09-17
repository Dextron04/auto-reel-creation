const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OLLAMA_URL = 'https://ollama.dextron04.in/api/generate';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OLLAMA_MODEL = 'tushin-agent:latest';

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function itemId(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function defaultDecision(item, reason = 'classifier unavailable') {
  return { id: item.id, in_scope: false, confidence: 0, reason };
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function promptFor(scope, items, kind) {
  const evidence = items.map((item) => ({
    id: item.id,
    title: safeText(item.title),
    summary: safeText(item.summary),
  }));
  return [
    'You are a constrained semantic classifier for research evidence.',
    'Classify each item only against the immutable registry scope below.',
    `Classification kind: ${kind}`,
    `Immutable registry scope: ${scope}`,
    '',
    'Return ONLY a JSON array. Each output object must contain exactly these keys: id, in_scope, confidence, reason.',
    'Use the supplied IDs exactly. Do not invent items, URLs, scope rules, or other fields.',
    'confidence must be a number from 0 to 1; in_scope must be a boolean.',
    `Evidence items: ${JSON.stringify(evidence)}`,
  ].join('\n');
}

function textFromBody(body) {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.content)) {
    const text = body.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (text) return text;
  }
  if (typeof body.response === 'string') return body.response;
  if (body.message) {
    const messageText = textFromBody(body.message);
    if (messageText) return messageText;
  }
  return '';
}

async function bodyOf(response) {
  if (typeof response?.json === 'function') {
    try { return await response.json(); } catch { /* stream responses are not JSON documents */ }
  }
  if (typeof response?.text === 'function') return response.text();
  return '';
}

function stripFence(value) {
  const text = safeText(value);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  return (fenced ? fenced[1] : text).trim();
}

function parseJsonCandidates(text) {
  const source = stripFence(text);
  const candidates = [source];
  const firstArray = source.indexOf('[');
  const lastArray = source.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(source.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try a bounded extraction below */ }
  }
  throw new Error('CLASSIFIER_INVALID_JSON');
}

function parseClassifierOutput(text) {
  let parsed;
  const source = safeText(text);
  try {
    parsed = parseJsonCandidates(source);
  } catch {
    // Ollama's stream is newline-delimited JSON. Join only response fragments;
    // this also handles a stream represented as a plain text response.
    const fragments = source.split(/\r?\n/).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).map((entry) => typeof entry.response === 'string' ? entry.response : '');
    if (!fragments.length) throw new Error('CLASSIFIER_INVALID_JSON');
    parsed = parseJsonCandidates(fragments.join(''));
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.results;
  if (!Array.isArray(rows)) throw new Error('CLASSIFIER_INVALID_SCHEMA');
  return rows;
}

function decisionsFor(items, rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = itemId(row.id);
    if (!id || byId.has(id)) continue;
    byId.set(id, row);
  }
  return items.map((item) => {
    const row = byId.get(itemId(item.id));
    if (!row) return defaultDecision(item, 'classifier omitted item');
    return {
      id: item.id,
      in_scope: row.in_scope === true,
      confidence: clampConfidence(row.confidence),
      reason: safeText(row.reason) || 'classifier gave no reason',
    };
  });
}

async function classifyWithAnthropic({ fetchImpl, prompt, env }) {
  const response = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': String(env.ANTHROPIC_API_KEY),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response?.ok) throw new Error(`CLASSIFIER_ANTHROPIC_HTTP:${response?.status ?? 'unknown'}`);
  const body = await bodyOf(response);
  return parseClassifierOutput(textFromBody(body));
}

async function classifyWithQwen({ fetchImpl, prompt, env }) {
  const response = await fetchImpl(OLLAMA_URL, {
    method: 'POST',
    headers: {
      'CF-Access-Client-Id': String(env.OLLAMA_CF_ACCESS_CLIENT_ID),
      'CF-Access-Client-Secret': String(env.OLLAMA_CF_ACCESS_CLIENT_SECRET),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_OLLAMA_MODEL,
      prompt,
      stream: true,
      options: { temperature: 0.2 },
    }),
  });
  if (!response?.ok) throw new Error(`CLASSIFIER_OLLAMA_HTTP:${response?.status ?? 'unknown'}`);
  const body = await bodyOf(response);
  return parseClassifierOutput(textFromBody(body));
}

export async function classifyResearchItems({
  topic,
  items = [],
  kind = 'research-source',
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (!Array.isArray(items)) throw new Error('CLASSIFIER_ITEMS_INVALID');
  if (items.length === 0) return [];
  const scope = safeText(topic?.scope);
  if (!scope) throw new Error('CLASSIFIER_SCOPE_REQUIRED');
  const normalizedItems = items.map((item) => ({
    id: item?.id,
    title: safeText(item?.title),
    summary: safeText(item?.summary),
  }));
  if (normalizedItems.some((item) => !itemId(item.id))) throw new Error('CLASSIFIER_ITEM_ID_REQUIRED');
  const prompt = promptFor(scope, normalizedItems, safeText(kind) || 'research-source');
  let rows;
  if (safeText(env?.ANTHROPIC_API_KEY)) {
    try {
      rows = await classifyWithAnthropic({ fetchImpl, prompt, env });
    } catch {
      // Existing workflow policy retries the same constrained prompt locally.
    }
  }
  if (!rows && safeText(env?.OLLAMA_CF_ACCESS_CLIENT_ID) && safeText(env?.OLLAMA_CF_ACCESS_CLIENT_SECRET)) {
    try {
      rows = await classifyWithQwen({ fetchImpl, prompt, env });
    } catch {
      // Classification is advisory; fail closed when both providers are unavailable.
    }
  }
  return rows ? decisionsFor(normalizedItems, rows) : normalizedItems.map((item) => defaultDecision(item));
}
