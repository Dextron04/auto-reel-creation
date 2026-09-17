import { getResearchTopic, TOPIC_FORMATS } from './research-topic-registry.mjs';
import { canonicalizeResearchUrl } from './research-sources.mjs';

const MAX_CANDIDATES = 5;
const CLASSIFIER_CONFIDENCE = 0.75;
const TREND_RECENCY_DAYS = 180;

const COMMON_FIELDS = [
  'topic', 'tool_name', 'category', 'hook', 'visual_angle', 'claims',
];
const FORMAT_FIELDS = {
  tips: [
    'one_line_value', 'what_it_is', 'why_not_obvious', 'concrete_payoff', 'who_it_helps',
  ],
  trend: [
    'one_line_value', 'developer_workflow', 'who_it_helps', 'why_now', 'why_it_matters',
  ],
};

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function identity(candidate) {
  return `${normalized(candidate?.topic)}|${normalized(candidate?.tool_name)}`;
}

function candidateText(candidate) {
  return [
    candidate?.topic,
    candidate?.tool_name,
    candidate?.category,
    candidate?.one_line_value,
    candidate?.what_it_is,
    candidate?.developer_workflow,
    candidate?.who_it_helps,
    candidate?.why_now,
    candidate?.hook,
    candidate?.why_it_matters,
    candidate?.visual_angle,
    ...(Array.isArray(candidate?.claims) ? candidate.claims.flatMap((claim) => [claim?.statement, claim?.publisher]) : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function matchesTerm(text, term) {
  const needle = normalized(term);
  if (!needle) return false;
  const haystack = normalized(text);
  if (haystack.includes(needle)) return true;
  // Registry vocabulary uses both "vscode" and the commonly written
  // "VS Code" spelling; compare a compact form only for that abbreviation.
  return needle === 'vscode' && haystack.replace(/[^a-z0-9]/g, '').includes('vscode');
}

function isPrimary(source) {
  return source?.source_type === 'repository' || String(source?.source_type ?? '').startsWith('official');
}

function evidenceRows(evidence) {
  if (Array.isArray(evidence)) return evidence;
  if (evidence && typeof evidence === 'object') return Object.values(evidence);
  return [];
}

function evidenceUrl(source) {
  return canonicalizeResearchUrl(source?.source_url ?? source?.url ?? source?.result_url);
}

function classifierDecision(decisions, candidate, index) {
  if (Array.isArray(decisions)) return decisions[index] ?? null;
  if (decisions && typeof decisions === 'object') {
    return decisions[identity(candidate)] ?? decisions[candidate?.tool_name] ?? decisions[index] ?? null;
  }
  return null;
}

function classifierAllows(decision) {
  return decision?.in_scope === true && Number(decision?.confidence) >= CLASSIFIER_CONFIDENCE;
}

function failure(failureCode, reasons, diagnostics) {
  return { valid: false, failureCode, reasons: [...new Set(reasons)], diagnostics };
}

function hasSpecificAction(candidate) {
  const action = [
    candidate?.specific_action,
    candidate?.action,
    candidate?.what_it_is,
    candidate?.one_line_value,
    candidate?.developer_workflow,
  ].filter(nonEmpty).join(' ');
  return /\b(use|run|enable|set|add|remove|configure|inspect|query|index|explain|analy[sz]e|profile|trace|debug|press|toggle|command|shortcut|flag|option|hook|cache|pool|rerun|filter|search|rebase|bisect|worktree|instrument)\b/i.test(action);
}

function hasConcretePayoff(candidate) {
  const payoff = String(candidate?.concrete_payoff ?? '').trim();
  if (!payoff || payoff.length < 10) return false;
  if (/^(improves?|better|faster|more efficient|helps?|boosts?)\s+(performance|productivity|workflow|speed|debugging)\.?$/i.test(payoff)) return false;
  return /\b(avoid|catch|find|fix|reduce|save|remove|surface|prevent|before|after|fewer|less|more|seconds?|minutes?|hours?|ms|latency|query|bug|error|friction|steps?|time)\b/i.test(payoff);
}

const VAGUE_TREND_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'current', 'daily', 'developer', 'developers',
  'feature', 'for', 'from', 'helps', 'in', 'it', 'new', 'now', 'of', 'on', 'the',
  'this', 'to', 'use', 'users', 'using', 'workflow', 'works', 'with',
]);

function meaningfulTokens(value) {
  return new Set(normalized(value).split(' ').filter((word) => word.length >= 4 && !VAGUE_TREND_WORDS.has(word)));
}

function hasConcreteWorkflow(candidate) {
  const workflow = String(candidate?.developer_workflow ?? '').trim();
  if (workflow.length < 18 || /^(improves?|optimizes?|helps?|supports?)\s+(the\s+)?(developer\s+)?workflow\.?$/i.test(workflow)) return false;
  return /\b(use|run|enable|configure|inspect|query|index|trace|debug|profile|commit|branch|rebase|worktree|instrument|deploy|measure|compare|find|fix|automate)\b/i.test(workflow);
}

function whyNowIsTraceable(candidate, cited) {
  const whyNow = String(candidate?.why_now ?? '').trim();
  if (whyNow.length < 16 || !/\b(recent|recently|today|this\s+week|this\s+month|new|release|released|launch|launched|announce|announced|update|updated|version|now|latest|changed|adds?|introduced)\b/i.test(whyNow)) return false;
  const whyTokens = meaningfulTokens(whyNow);
  const whyEventTokens = [...whyTokens].filter((token) => /^(recent|recently|today|week|month|release|released|launch|launched|announce|announced|update|updated|version|latest|changed|adds|added|introduced)$/.test(token));
  // Claims are intentionally absent here: they prove only that the model
  // cited a supplied URL. Timing must be grounded in trusted evidence text.
  return cited.some(({ evidence: source }) => {
    const publishedAt = new Date(source?.published_at ?? '');
    if (!source?.published_at || Number.isNaN(publishedAt.getTime())) return false;
    const support = [source?.title, source?.summary, source?.publisher, source?.source_type].filter(nonEmpty).join(' ');
    const supportTokens = meaningfulTokens(support);
    const topicOverlap = [...whyTokens].some((token) => supportTokens.has(token));
    const eventText = support.toLowerCase();
    const hasEventAssertion = (
      /\b(?:now\s+supports?|new\s+version|version\s*(?:v?\d|[a-z]))\b/i.test(eventText)
      || /\b(?:released?|launched?|announced?|announcement|introduced)\b/i.test(eventText)
      || /\b(?:added|adds|changed)\b[^.]{0,80}\b(?:feature|support|capability|option|command|workflow|version|v?\d)\b/i.test(eventText)
      || /\bupdated?\b[^.]{0,80}\b(?:to|with|feature|support|version|v?\d|adds?|introduces?)\b/i.test(eventText)
      || /\b(?:release\s+notes?|changelog)\b/i.test(eventText)
    );
    const eventOverlap = whyEventTokens.some((token) => supportTokens.has(token));
    return topicOverlap && hasEventAssertion && eventOverlap;
  });
}

function isRecent(source, now) {
  if (!source?.published_at) return false;
  const published = new Date(source.published_at);
  if (Number.isNaN(published.getTime())) return false;
  const age = Math.max(0, new Date(now).getTime() - published.getTime()) / 86_400_000;
  return age <= TREND_RECENCY_DAYS;
}

/**
 * Validate a model-produced package without mutating it. The model may only
 * select candidates and cite the supplied evidence; this function never
 * repairs or replaces either object.
 */
export async function validateResearchPackage({
  topicSlug,
  format,
  evidence,
  research,
  classifyCandidate,
  now = new Date(),
} = {}) {
  let topic;
  try {
    topic = getResearchTopic(topicSlug);
  } catch {
    return failure('UNKNOWN_TOPIC', [`UNKNOWN_TOPIC:${topicSlug}`], { topicSlug, format, candidateCount: 0, evidenceCount: 0 });
  }
  if (!TOPIC_FORMATS.includes(format)) {
    return failure('INVALID_FORMAT', [`INVALID_FORMAT:${format}`], { topicSlug, format, candidateCount: 0, evidenceCount: 0 });
  }

  const rows = evidenceRows(evidence);
  const diagnostics = {
    topicSlug,
    format,
    candidateCount: Array.isArray(research?.candidates) ? research.candidates.length : 0,
    evidenceCount: rows.length,
    primaryEvidenceCount: 0,
    citedEvidenceCount: 0,
    ambiguousCandidateCount: 0,
  };

  const candidates = research?.candidates;
  const recommended = research?.recommended_topic;
  const noResultStatus = research?.status === 'no_in_scope_research';
  const genuinelyEmpty = (candidates == null || (Array.isArray(candidates) && candidates.length === 0)) && recommended == null;
  if (noResultStatus && genuinelyEmpty) {
    return failure('NO_IN_SCOPE_RESEARCH', ['NO_IN_SCOPE_RESEARCH'], { ...diagnostics, outcome: 'no_in_scope_research' });
  }
  if (noResultStatus) {
    return failure('INVALID_RESEARCH', ['MALFORMED_NO_RESULT'], { ...diagnostics, outcome: 'invalid_research' });
  }
  if (Array.isArray(candidates) && candidates.length === 0 && recommended == null) {
    return failure('NO_IN_SCOPE_RESEARCH', ['NO_IN_SCOPE_RESEARCH'], { ...diagnostics, outcome: 'no_in_scope_research' });
  }
  if (!research || typeof research !== 'object' || Array.isArray(research)) {
    return failure('INVALID_RESEARCH', ['INVALID_RESEARCH'], diagnostics);
  }
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
    return failure('CANDIDATE_COUNT', [`CANDIDATE_COUNT:${Array.isArray(candidates) ? candidates.length : 'missing'}`], diagnostics);
  }
  if (!recommended || typeof recommended !== 'object' || identity(recommended) !== identity(candidates[0])) {
    return failure('RECOMMENDATION_ORDER', ['RECOMMENDED_TOPIC_NOT_FIRST'], diagnostics);
  }

  const canonicalEvidence = new Map();
  for (const row of rows) {
    const url = evidenceUrl(row);
    if (!url) continue;
    const existing = canonicalEvidence.get(url);
    // Keep whichever duplicate carries primary authority. This prevents a
    // later low-authority row from erasing an official/repository source.
    if (!existing || (!isPrimary(existing) && isPrimary(row))) canonicalEvidence.set(url, row);
  }
  diagnostics.primaryEvidenceCount = [...canonicalEvidence.values()].filter(isPrimary).length;
  const reasons = [];
  const ambiguous = [];
  const evidenceByCandidate = new Map();

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      reasons.push(`MISSING_REQUIRED_FIELD:candidate[${index}]`);
      continue;
    }
    for (const field of [...COMMON_FIELDS, ...FORMAT_FIELDS[format]]) {
      if (field === 'claims') continue;
      if (!nonEmpty(candidate[field])) reasons.push(`MISSING_REQUIRED_FIELD:${field}:${index}`);
    }

    const text = candidateText(candidate);
    const explicitEditorHarnessExclusion = topicSlug === 'editor-ide'
      && /\bai\s+sdk\b/i.test(text)
      && /\bharness\b/i.test(text);
    const excluded = topic.excludeTerms.filter((term) => matchesTerm(text, term));
    if (explicitEditorHarnessExclusion) excluded.push('ai sdk harness');
    const matched = topic.includeTerms.filter((term) => matchesTerm(text, term));
    if (excluded.length) reasons.push(`OFF_TOPIC_CANDIDATE:${index}:excluded:${excluded.join(',')}`);
    else if (!matched.length) ambiguous.push({ candidate, index });

    if (!Array.isArray(candidate.claims) || candidate.claims.length < 1) {
      reasons.push(`MISSING_REQUIRED_FIELD:claims:${index}`);
      continue;
    }
    const cited = [];
    for (const [claimIndex, claim] of candidate.claims.entries()) {
      const claimUrl = canonicalizeResearchUrl(claim?.source_url);
      if (!claim || !nonEmpty(claim.statement) || !claimUrl || !canonicalEvidence.has(claimUrl)) {
        reasons.push(`UNSUPPORTED_CLAIM:${index}:${claimIndex}`);
      } else {
        cited.push({ url: claimUrl, evidence: canonicalEvidence.get(claimUrl), claim });
      }
    }
    evidenceByCandidate.set(index, cited);

    if (format === 'tips') {
      if (!hasSpecificAction(candidate)) reasons.push(`TIP_ACTION_REQUIRED:${index}`);
      if (!hasConcretePayoff(candidate)) reasons.push(`TIP_PAYOFF_REQUIRED:${index}`);
    } else {
      if (!hasConcreteWorkflow(candidate)) reasons.push(`TREND_WORKFLOW_REQUIRED:${index}`);
      if (!whyNowIsTraceable(candidate, cited)) reasons.push(`TREND_WHY_NOW_REQUIRED:${index}`);
      if (!cited.some(({ evidence: source }) => isRecent(source, now))) reasons.push(`TREND_RECENT_EVIDENCE_REQUIRED:${index}`);
    }
  }

  // Unknown URLs and deterministic exclusions are checked before any model
  // callback. Only lexical ambiguity is delegated, in one batch.
  if (!reasons.some((reason) => reason.startsWith('UNSUPPORTED_CLAIM') || reason.startsWith('OFF_TOPIC_CANDIDATE'))) {
    diagnostics.ambiguousCandidateCount = ambiguous.length;
    if (ambiguous.length) {
      let decisions = [];
      if (typeof classifyCandidate === 'function') {
        decisions = await classifyCandidate(ambiguous.map(({ candidate }) => candidate), {
          topic,
          topicSlug,
          format,
          scope: topic.scope,
        });
      }
      for (const [decisionIndex, { index }] of ambiguous.entries()) {
        if (!classifierAllows(classifierDecision(decisions, candidates[index], decisionIndex))) reasons.push(`OFF_TOPIC_CANDIDATE:${index}:classifier`);
      }
    }
  }

  const recommendationEvidence = evidenceByCandidate.get(0) ?? [];
  diagnostics.citedEvidenceCount = new Set([...evidenceByCandidate.values()].flat().map(({ url }) => url)).size;
  if (!recommendationEvidence.some(({ evidence: source }) => isPrimary(source))) reasons.push('NO_PRIMARY_SOURCE');
  if (reasons.length) {
    const priority = [
      'RECOMMENDATION_ORDER', 'UNSUPPORTED_CLAIM', 'OFF_TOPIC_CANDIDATE',
      'MISSING_REQUIRED_FIELD', 'TIP_ACTION_REQUIRED', 'TIP_PAYOFF_REQUIRED',
      'TREND_WHY_NOW_REQUIRED', 'TREND_WORKFLOW_REQUIRED', 'TREND_RECENT_EVIDENCE_REQUIRED',
      'NO_PRIMARY_SOURCE', 'CANDIDATE_COUNT',
    ];
    const failureCode = priority.find((code) => reasons.some((reason) => reason.startsWith(code))) ?? 'INVALID_RESEARCH';
    return failure(failureCode, reasons, diagnostics);
  }
  return { valid: true, research, diagnostics, reasons: [] };
}
