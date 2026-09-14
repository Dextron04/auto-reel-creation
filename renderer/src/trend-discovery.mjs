const DEFAULT_LIMITS = {maxPerPublisher: 3, maxSignals: 45, minSignals: 5};

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const canonicalUrl = value => { try { const u = new URL(String(value)); u.hash = ''; u.search = ''; return u.href.replace(/\/$/, '').toLowerCase(); } catch { return clean(value).toLowerCase(); } };
const productKey = value => clean(value).toLowerCase().replace(/\b(v\d+(?:\.\d+)*)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function normalizeSignal(raw, source, now = new Date().toISOString()) {
  const item = raw ?? {};
  const engagement = {};
  for (const key of ['score','comments','stars','star_velocity','votes']) {
    if (item.engagement?.[key] != null || item[key] != null) engagement[key] = Number(item.engagement?.[key] ?? item[key]);
  }
  return {
    signal_id: clean(item.signal_id ?? item.id ?? canonicalUrl(item.source_url ?? item.url ?? item.title)),
    title: clean(item.title), summary: clean(item.summary ?? item.description),
    source_url: clean(item.source_url ?? item.url), publisher: clean(item.publisher ?? source),
    published_at: clean(item.published_at ?? item.publishedAt), retrieved_at: clean(item.retrieved_at ?? now),
    category: clean(item.category ?? item.content_category ?? 'other').toLowerCase(),
    engagement, authority_score: Number(item.authority_score ?? item.authorityScore ?? 0),
    developer_relevance: Number(item.developer_relevance ?? item.developerRelevance ?? 0),
  };
}

export function deduplicateSignals(signals) {
  const seen = new Map();
  for (const signal of signals) {
    const key = `${canonicalUrl(signal.source_url)}|${productKey(signal.title)}`;
    const previous = seen.get(key);
    if (!previous || (signal.authority_score + signal.developer_relevance) > (previous.authority_score + previous.developer_relevance)) seen.set(key, signal);
  }
  return [...seen.values()];
}

export function selectBalancedSignals(signals, limits = {}) {
  const opts = {...DEFAULT_LIMITS, ...limits};
  const buckets = new Map(); const publishers = new Map();
  for (const signal of [...signals].sort((a,b) => (b.developer_relevance + b.authority_score) - (a.developer_relevance + a.authority_score))) {
    const publisher = signal.publisher || 'unknown';
    if ((publishers.get(publisher) ?? 0) >= opts.maxPerPublisher) continue;
    const category = signal.category || 'other';
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(signal);
  }
  const out = []; const categories = [...buckets.keys()];
  while (out.length < opts.maxSignals && categories.some(c => buckets.get(c).length)) {
    for (const category of categories) {
      const next = buckets.get(category).shift(); if (!next) continue;
      const publisher = next.publisher || 'unknown';
      if ((publishers.get(publisher) ?? 0) >= opts.maxPerPublisher) continue;
      publishers.set(publisher, (publishers.get(publisher) ?? 0) + 1); out.push(next);
      if (out.length >= opts.maxSignals) break;
    }
  }
  if (out.length < opts.minSignals) throw new Error('TREND_DISCOVERY_INSUFFICIENT');
  return out;
}

export function discoverTrends({sources = [], now = new Date().toISOString(), history = [], limits = {}} = {}) {
  const archived = new Set(history.flatMap(item => [item.topic, item.tool_name]).map(productKey).filter(Boolean));
  const normalized = sources.flatMap(entry => (Array.isArray(entry.items) ? entry.items : entry.data ?? []).map(raw => normalizeSignal(raw, entry.publisher ?? entry.source, now)));
  const deduped = deduplicateSignals(normalized);
  const rejected = [];
  const eligible = deduped.filter(signal => {
    const key = productKey(signal.title);
    if (archived.has(key)) { rejected.push({signal, reason:'TOPIC_ARCHIVED'}); return false; }
    if (!signal.source_url || !signal.title) { rejected.push({signal, reason:'MISSING_IDENTITY'}); return false; }
    return true;
  });
  return {signals: selectBalancedSignals(eligible, limits), rejected, diagnostics: {received: normalized.length, deduped: deduped.length, selected: eligible.length}};
}
