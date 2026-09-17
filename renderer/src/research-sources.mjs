import { getResearchTopic, TOPIC_FORMATS } from './research-topic-registry.mjs';
import { readResearchCache, writeResearchCache } from './research-cache.mjs';

const TRACKING_PARAMETERS = /^(utm_.*|fbclid|gclid|dclid|mc_cid|mc_eid|ref|referrer|source)$/i;
const SENSITIVE_PARAMETERS = /^(api_key|apikey|key|token|access_token|auth|authorization|secret|signature)$/i;
const BORDERLINE_CONFIDENCE = 0.75;
const MAX_PER_QUERY = 10;
const MAX_RAW = 100;
const MAX_SOURCES = 20;

export function canonicalizeResearchUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try { parsed = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hostname = parsed.hostname.replace(/^www\./, '');
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.test(key) || SENSITIVE_PARAMETERS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

export function buildResearchQueries(topic, format, expanded = false) {
  if (!topic || !TOPIC_FORMATS.includes(format)) throw new Error(`RESEARCH_FORMAT_INVALID:${format}`);
  const queries = [...(format === 'tips' ? topic.tipsQueries : topic.trendQueries)];
  if (!expanded) return queries;
  return queries.map((query) => `${query} developer practical ${format === 'trend' ? 'recent' : 'guide'}`);
}

function textOf(source) {
  return [source.title, source.summary, source.publisher, source.source_url, source.url].filter(Boolean).join(' ').toLowerCase();
}

function matchesTerm(text, term) {
  const needle = String(term).toLowerCase().trim();
  if (text.includes(needle)) return true;
  // Search engines and publishers commonly spell VS Code, git-cli, etc. with
  // punctuation or whitespace that differs from registry vocabulary.
  const compact = (value) => value.replace(/[^a-z0-9]+/g, '');
  // Handle the common VS Code abbreviation without allowing a host such as
  // code.visualstudio.com to masquerade as a lexical "visual studio" hit.
  return compact(needle) === 'vscode' && compact(text).includes('vscode');
}

function removeOverlappingTerms(terms) {
  return terms.filter((term) => !terms.some((other) => other !== term && other.length > term.length && other.includes(term)));
}

function domainMatches(host, domain) {
  const wanted = String(domain).toLowerCase().replace(/^www\./, '');
  const actual = String(host).toLowerCase().replace(/^www\./, '');
  return actual === wanted || actual.endsWith(`.${wanted}`);
}

function publisherFor(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function sourceTypeFor(url, publisher, raw) {
  const text = `${url} ${publisher} ${raw?.title ?? ''}`.toLowerCase();
  if (/\/docs?\b|documentation|manual|guide/.test(text)) return 'official-docs';
  if (/release|changelog|announcement|blog\./.test(text)) return 'official-changelog';
  if (publisher === 'github.com' || /repository|repo/.test(text)) return 'repository';
  if (/forum|reddit|stackoverflow|community/.test(text)) return 'community';
  return 'article';
}

export function normalizeResearchResult(raw, context = {}) {
  const sourceUrl = canonicalizeResearchUrl(raw?.url ?? raw?.result_url ?? raw?.source_url);
  if (!sourceUrl) return null;
  const topic = context.topic;
  const retrieved = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
  const publishedAt = raw?.published_at ?? raw?.publishedDate ?? raw?.published ?? raw?.date ?? null;
  const publisher = raw?.publisher || publisherFor(sourceUrl);
  const parsedPublishedAt = publishedAt ? new Date(publishedAt) : null;
  return {
    title: String(raw?.title ?? '').trim(),
    summary: String(raw?.summary ?? raw?.content ?? raw?.snippet ?? raw?.description ?? '').trim(),
    source_url: sourceUrl,
    publisher,
    published_at: parsedPublishedAt && !Number.isNaN(parsedPublishedAt.getTime()) ? parsedPublishedAt.toISOString() : null,
    retrieved_at: retrieved.toISOString(),
    source_type: raw?.source_type ?? sourceTypeFor(sourceUrl, publisher, raw),
    query: context.query ?? raw?.query ?? '',
    topic_slug: context.topicSlug ?? topic?.slug,
    format: context.format,
    raw_rank: context.rawRank ?? raw?.rank ?? null,
  };
}

export function scoreResearchSource(source, topic, format, now = new Date()) {
  const text = textOf(source);
  const matched = removeOverlappingTerms(topic.includeTerms.filter((term) => matchesTerm(text, term)));
  const excluded = removeOverlappingTerms(topic.excludeTerms.filter((term) => matchesTerm(text, term)));
  let host = '';
  try { host = new URL(source.source_url).hostname; } catch { /* normalized inputs are expected */ }
  const preferred = topic.preferredDomains.some((domain) => domainMatches(host, domain));
  const published = source.published_at ? new Date(source.published_at) : null;
  const ageDays = published && !Number.isNaN(published.getTime()) ? Math.max(0, (new Date(now).getTime() - published.getTime()) / 86_400_000) : 365;
  const recencyScore = format === 'trend' ? Math.max(0, Math.exp(-ageDays / 45)) : Math.max(0, Math.exp(-ageDays / 180));
  const lexicalScore = Math.min(1, matched.length / 2);
  const authorityScore = preferred ? 1 : (source.source_type?.startsWith('official') || source.source_type === 'repository' ? 0.7 : 0.35);
  const exclusionScore = excluded.length ? -1 : 0;
  const relevanceScore = Math.max(0, (lexicalScore * 0.5) + (authorityScore * 0.25) + (recencyScore * 0.15) + 0.1 + exclusionScore);
  return {
    ...source,
    lexical_score: lexicalScore,
    domain_score: preferred ? 1 : 0,
    recency_score: recencyScore,
    authority_score: authorityScore,
    relevance_score: relevanceScore,
    relevance_reasons: [...matched.map((term) => `include:${term}`), ...excluded.map((term) => `exclude:${term}`), ...(preferred ? ['preferred-domain'] : [])],
    matched_terms: matched,
    excluded_terms: excluded,
  };
}

function decisionFor(source, decisions) {
  if (!decisions) return null;
  if (decisions instanceof Map) return decisions.get(source.source_url) ?? decisions.get(source);
  if (Array.isArray(decisions)) return decisions[source._borderlineIndex] ?? null;
  return decisions[source.source_url] ?? null;
}

export function filterResearchSources(sources, topic, format, options = {}) {
  const now = options.now ?? new Date();
  const scored = sources.map((source) => source.relevance_score == null ? scoreResearchSource(source, topic, format, now) : source);
  const accepted = [];
  let borderlineIndex = 0;
  for (const source of scored) {
    const text = textOf(source);
    const excluded = topic.excludeTerms.some((term) => matchesTerm(text, term));
    if (excluded) continue;
    const lexical = source.matched_terms?.length ?? topic.includeTerms.filter((term) => matchesTerm(text, term)).length;
    const preferred = source.domain_score === 1;
    const authoritative = source.source_type?.startsWith('official') || source.source_type === 'repository';
    // Tips require meaningful lexical coverage; a lone generic term remains
    // borderline unless the source is both preferred and authoritative.
    // Trends may admit one term from a preferred/authoritative source because
    // release headlines are intentionally concise.
    const lexicalThreshold = format === 'tips' ? 2 : 1;
    const deterministic = lexical >= lexicalThreshold && (preferred || authoritative);
    const strongSingleTerm = lexical === 1 && preferred && authoritative;
    if (deterministic || strongSingleTerm) {
      accepted.push(source);
      continue;
    }
    const tagged = { ...source, _borderlineIndex: borderlineIndex++ };
    const decision = decisionFor(tagged, options.borderlineDecisions);
    if (decision?.in_scope === true && Number(decision.confidence) >= (options.confidenceThreshold ?? BORDERLINE_CONFIDENCE)) accepted.push(tagged);
  }
  return accepted
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, options.limit ?? MAX_SOURCES)
    .map(({ _borderlineIndex, matched_terms, excluded_terms, ...source }) => source);
}

function primaryCount(sources) {
  return sources.filter((source) => source.source_type?.startsWith('official') || source.source_type === 'repository').length;
}

function diagnostics(queryCount, rawCount, dedupedCount, qualified, cacheHit = false) {
  return { queryCount, rawCount, dedupedCount, qualifiedCount: qualified.length, primaryCount: primaryCount(qualified), cacheHit };
}

async function querySearxng({ fetchImpl, searxngUrl, queries, topic, format, now }) {
  const rows = [];
  for (const query of queries) {
    const url = new URL('/search', searxngUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');
    const response = await fetchImpl(url);
    if (!response?.ok) throw new Error(`SEARXNG_HTTP_ERROR:${response?.status ?? 'unknown'}`);
    let body;
    try { body = await response.json(); } catch (error) { throw new Error(`SEARXNG_INVALID_JSON:${error.message}`); }
    const results = Array.isArray(body?.results) ? body.results : [];
    for (const [rank, raw] of results.slice(0, MAX_PER_QUERY).entries()) {
      const normalized = normalizeResearchResult(raw, { topic, topicSlug: topic.slug, format, query, now, rawRank: rank });
      if (normalized) rows.push(normalized);
      if (rows.length >= MAX_RAW) return rows;
    }
  }
  return rows;
}

async function runBorderlineClassifier(rows, topic, format, callback) {
  if (!rows.length || typeof callback !== 'function') return [];
  const decisions = await callback(rows, { topic, format, scope: topic.scope });
  return Array.isArray(decisions) ? decisions : rows.map((row) => decisions?.[row.source_url] ?? null);
}

export async function retrieveResearchSources({
  topicSlug,
  format,
  recentTopics = [],
  fetchImpl = fetch,
  searxngUrl = process.env.SEARXNG_URL,
  now = new Date(),
  mediaDir = process.env.MEDIA_ROOT ?? '/media',
  classifyBorderline,
} = {}) {
  const topic = getResearchTopic(topicSlug);
  if (!TOPIC_FORMATS.includes(format)) throw new Error(`RESEARCH_FORMAT_INVALID:${format}`);
  if (!searxngUrl) throw new Error('SEARXNG_URL_REQUIRED');
  try { new URL(searxngUrl); } catch { throw new Error('SEARXNG_URL_INVALID'); }
  const cached = await readResearchCache({ topicSlug, format, now, mediaDir });
  if (cached && cached.status && cached.diagnostics) {
    return { ...cached, diagnostics: { ...cached.diagnostics, cacheHit: true } };
  }
  const firstQueries = buildResearchQueries(topic, format, false);
  const firstRows = await querySearxng({ fetchImpl, searxngUrl, queries: firstQueries, topic, format, now });
  let rows = firstRows;
  const normalizedUnique = new Map(rows.map((row) => [row.source_url, row]));
  let dedupedCount = normalizedUnique.size;
  let scoredRows = [...normalizedUnique.values()].map((row) => scoreResearchSource(row, topic, format, now));
  let deterministic = filterResearchSources(scoredRows, topic, format, { now, limit: MAX_RAW });
  let expansionAttempted = false;
  if (deterministic.length < topic.minimumQualifiedSources) {
    expansionAttempted = true;
    const expandedQueries = buildResearchQueries(topic, format, true);
    const expandedRows = await querySearxng({ fetchImpl, searxngUrl, queries: expandedQueries, topic, format, now });
    rows = [...rows, ...expandedRows];
    for (const row of expandedRows) normalizedUnique.set(row.source_url, row);
    dedupedCount = normalizedUnique.size;
    scoredRows = [...normalizedUnique.values()].map((row) => scoreResearchSource(row, topic, format, now));
    deterministic = filterResearchSources(scoredRows, topic, format, { now, limit: MAX_RAW });
  }
  const borderline = scoredRows.filter((row) => !row.excluded_terms?.length && !(row.matched_terms?.length));
  const decisions = await runBorderlineClassifier(borderline, topic, format, classifyBorderline);
  const indexDecisions = new Map(borderline.map((row, index) => [row.source_url, decisions[index]]));
  const qualified = filterResearchSources(scoredRows, topic, format, { now, limit: MAX_SOURCES, borderlineDecisions: indexDecisions });
  const baseDiagnostics = diagnostics(firstQueries.length + (expansionAttempted ? buildResearchQueries(topic, format, true).length : 0), rows.length, dedupedCount, qualified);
  const finalSources = qualified.slice(0, MAX_SOURCES);
  const enough = finalSources.length >= topic.minimumQualifiedSources && primaryCount(finalSources) >= topic.minimumPrimarySources;
  const result = enough ? { status: 'ready', topicSlug, format, sources: finalSources, diagnostics: baseDiagnostics } : {
    status: 'no_in_scope_research', topicSlug, format, sources: [], diagnostics: baseDiagnostics,
    reason: `fewer than ${topic.minimumQualifiedSources} qualified sources or ${topic.minimumPrimarySources} primary source`,
  };
  await writeResearchCache({ topicSlug, format, now, mediaDir }, result).catch(() => {});
  return result;
}
