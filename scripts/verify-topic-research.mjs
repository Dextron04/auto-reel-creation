// Shadow-mode structural verification for all ten topic/format combinations. This calls only the
// renderer's research retrieval and validation endpoints -- never dialogue, visuals, TTS, render,
// topic-history writes, or publishing -- so it is safe to run against a live renderer at any time,
// including in production, without side effects.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_SLUGS, TOPIC_FORMATS } from '../renderer/src/research-topic-registry.mjs';

const MAX_SOURCES = 20;

function acceptSources(result) {
  const reasons = [];
  if (result.status !== 'ready' && result.status !== 'no_in_scope_research') {
    reasons.push(`unexpected status '${result.status}'`);
    return reasons;
  }
  if (!Array.isArray(result.sources)) { reasons.push('sources must be an array'); return reasons; }
  if (result.sources.length > MAX_SOURCES) reasons.push(`sources exceed the ${MAX_SOURCES}-source cap (${result.sources.length})`);
  if (result.status === 'ready') {
    if (result.sources.length < 1) reasons.push('ready outcome returned zero sources');
    if (!result.diagnostics || typeof result.diagnostics.primaryCount !== 'number' || result.diagnostics.primaryCount < 1) {
      reasons.push('ready outcome has no primary/official source in diagnostics');
    }
    for (const source of result.sources) {
      if (!source?.source_url) { reasons.push('a source is missing source_url'); break; }
    }
  }
  if (result.status === 'no_in_scope_research' && result.sources.length !== 0) reasons.push('no_in_scope_research outcome must return zero sources');
  if (!result.topic?.slug) reasons.push('response is missing the topic descriptor cores rely on');
  return reasons;
}

function acceptValidation(result) {
  const reasons = [];
  if (typeof result.valid !== 'boolean') { reasons.push('validation response missing boolean valid'); return reasons; }
  if (result.valid === false && !Array.isArray(result.reasons)) reasons.push('invalid result must include reasons');
  if (result.valid === true && !result.research) reasons.push('valid result must preserve the research payload');
  return reasons;
}

// A network-side effect on ANY of these paths would mean shadow mode is not actually side-effect
// free -- this is a hard fixed allowlist, not something a candidate/fixture can widen.
const ALLOWED_PATH_SUFFIXES = ['/v1/research/sources', '/v1/research/validate'];

export function guardedFetch(baseFetch) {
  return async (url, options) => {
    const pathname = new URL(url, 'http://placeholder').pathname;
    if (!ALLOWED_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
      throw new Error(`SHADOW_VERIFIER_FORBIDDEN_CALL:${pathname}`);
    }
    return baseFetch(url, options);
  };
}

export async function runShadowVerification({ baseUrl = 'http://127.0.0.1:3001', fetchImpl = fetch, fixtures = {} } = {}) {
  const guarded = guardedFetch(fetchImpl);
  const combinations = [];
  for (const slug of TOPIC_SLUGS) for (const format of TOPIC_FORMATS) combinations.push({ slug, format });

  const results = [];
  for (const { slug, format } of combinations) {
    const entry = { topicSlug: slug, format, ok: false, outcome: null, reasons: [] };
    try {
      const sourcesResponse = await guarded(new URL('/v1/research/sources', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicSlug: slug, format }),
      });
      if (!sourcesResponse.ok) {
        entry.reasons.push(`retrieval returned HTTP ${sourcesResponse.status}`);
        results.push(entry);
        continue;
      }
      const sourcesResult = await sourcesResponse.json();
      entry.outcome = sourcesResult.status;
      entry.diagnostics = sourcesResult.diagnostics ?? null;
      const sourceReasons = acceptSources(sourcesResult);
      entry.reasons.push(...sourceReasons);

      if (sourcesResult.status === 'no_in_scope_research') {
        // A clean skip is success, not a failure -- and there is nothing further to validate.
        entry.ok = sourceReasons.length === 0;
        results.push(entry);
        continue;
      }

      const fixtureResearch = fixtures[`${slug}:${format}`];
      if (fixtureResearch) {
        const validateResponse = await guarded(new URL('/v1/research/validate', baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topicSlug: slug, format, evidence: sourcesResult.sources, research: fixtureResearch }),
        });
        if (!validateResponse.ok && validateResponse.status !== 422) {
          entry.reasons.push(`validation returned HTTP ${validateResponse.status}`);
        } else {
          const validateResult = await validateResponse.json();
          entry.validation = { valid: validateResult.valid, failureCode: validateResult.failureCode ?? null };
          entry.reasons.push(...acceptValidation(validateResult));
        }
      }
      entry.ok = entry.reasons.length === 0;
    } catch (error) {
      entry.reasons.push(error.message);
    }
    results.push(entry);
  }

  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    combinations: results,
    allPassed: results.every((r) => r.ok),
  };
}

async function main() {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3001';
  const report = await runShadowVerification({ baseUrl });
  console.log(JSON.stringify(report, null, 2));
  if (!report.allPassed) process.exitCode = 1;
}

const isEntryModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryModule) await main();
