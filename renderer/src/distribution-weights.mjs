import fs from 'node:fs/promises';
import path from 'node:path';
import {TOPIC_SLUGS, TOPIC_FORMATS} from './research-topic-registry.mjs';

export const ARMS = Object.freeze(TOPIC_SLUGS.flatMap((slug) => TOPIC_FORMATS.map((format) => Object.freeze({slug, format}))));
export const DEFAULT_WEIGHT = 1 / ARMS.length;

export function armKey({slug, format}) {
  return `${slug}:${format}`;
}

export function defaultWeights() {
  return Object.fromEntries(ARMS.map((arm) => [armKey(arm), DEFAULT_WEIGHT]));
}

const defaultPath = () => path.join(process.env.MEDIA_ROOT ?? '/media', 'distribution-weights.json');

export async function readWeights(weightsPath = defaultPath()) {
  try {
    const raw = await fs.readFile(weightsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.weights !== 'object') throw new Error('DISTRIBUTION_WEIGHTS_INVALID');
    return {weights: {...defaultWeights(), ...parsed.weights}, updatedAt: parsed.updatedAt ?? null};
  } catch (error) {
    if (error?.code === 'ENOENT') return {weights: defaultWeights(), updatedAt: null};
    if (error?.message === 'DISTRIBUTION_WEIGHTS_INVALID') throw error;
    throw new Error('DISTRIBUTION_WEIGHTS_INVALID', {cause: error});
  }
}

export async function writeWeights({weights, updatedAt}, weightsPath = defaultPath()) {
  await fs.mkdir(path.dirname(weightsPath), {recursive: true});
  const temporaryPath = `${weightsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({weights, updatedAt}, null, 2));
  await fs.rename(temporaryPath, weightsPath);
  return {weights, updatedAt};
}

// Reach is the denominator Instagram itself surfaces for Reels engagement rate; plays/
// total_interactions are the fallbacks for the rare insights response missing reach.
export function engagementRate(insight = {}) {
  const numerator = ['likes', 'comments', 'shares', 'saved'].reduce((sum, key) => sum + (Number(insight[key]) || 0), 0);
  const denominator = Number(insight.reach) || Number(insight.plays) || Number(insight.total_interactions) || 0;
  return denominator > 0 ? numerator / denominator : 0;
}

// Joins the publish log against fetched insights and averages engagement rate per (topic, format)
// arm, restricted to a trailing window so a topic's rating reflects recent performance, not its
// entire history.
export function summarizeArmPerformance({log = [], insightsByMediaId = {}, windowDays = 30, now = new Date()} = {}) {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const byArm = new Map(ARMS.map((arm) => [armKey(arm), {...arm, sampleCount: 0, totalEngagementRate: 0, totalReach: 0}]));
  for (const entry of log) {
    const insight = insightsByMediaId[entry.mediaId];
    if (!insight) continue;
    if (new Date(entry.publishedAt).getTime() < cutoff) continue;
    const key = armKey({slug: entry.topicSlug, format: entry.format});
    const bucket = byArm.get(key);
    if (!bucket) continue;
    bucket.sampleCount += 1;
    bucket.totalEngagementRate += engagementRate(insight);
    bucket.totalReach += Number(insight.reach) || 0;
  }
  return [...byArm.values()].map((bucket) => ({
    slug: bucket.slug,
    format: bucket.format,
    sampleCount: bucket.sampleCount,
    avgEngagementRate: bucket.sampleCount > 0 ? bucket.totalEngagementRate / bucket.sampleCount : 0,
    totalReach: bucket.totalReach,
  }));
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function populationStdDev(values, avg) {
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)));
}

// Multiplicative z-score update: an arm that beats the field average gets a multiplier > 1 (pushed
// harder), one that trails gets < 1 (pushed less), and one without enough samples yet is left
// untouched (multiplier 1) rather than punished for a small sample. minWeight/maxWeight keep any
// single arm from starving or dominating the roster.
// ponytail: clamp-then-renormalize is a single pass, not iterative water-filling, so a renormalized
// weight can drift slightly outside [minWeight, maxWeight] at the extremes -- fine for 10 roughly
// evenly-weighted arms; revisit with a proper water-filling pass if bounds ever need to be exact.
export function computeWeights({stats = [], previousWeights = defaultWeights(), minSamples = 2, learningRate = 0.35, minWeight = 0.04, maxWeight = 0.30} = {}) {
  const eligible = stats.filter((s) => s.sampleCount >= minSamples);
  if (eligible.length < 2) {
    return {weights: previousWeights, updatedAt: new Date().toISOString(), changed: false, reason: 'INSUFFICIENT_SAMPLES', arms: stats.map((s) => ({...s, previousWeight: previousWeights[armKey(s)] ?? DEFAULT_WEIGHT, weight: previousWeights[armKey(s)] ?? DEFAULT_WEIGHT, zScore: null, multiplier: 1}))};
  }
  const rates = eligible.map((s) => s.avgEngagementRate);
  const avg = mean(rates);
  const stdDev = populationStdDev(rates, avg);

  const raw = stats.map((s) => {
    const key = armKey(s);
    const previousWeight = previousWeights[key] ?? DEFAULT_WEIGHT;
    const eligibleForZ = s.sampleCount >= minSamples && stdDev > 0;
    const zScore = eligibleForZ ? (s.avgEngagementRate - avg) / stdDev : null;
    const multiplier = eligibleForZ ? Math.exp(learningRate * zScore) : 1;
    return {...s, previousWeight, zScore, multiplier, rawWeight: previousWeight * multiplier};
  });

  const clamped = raw.map((arm) => ({...arm, weight: Math.min(maxWeight, Math.max(minWeight, arm.rawWeight))}));
  const total = clamped.reduce((sum, arm) => sum + arm.weight, 0);
  const normalized = clamped.map((arm) => ({...arm, weight: arm.weight / total}));

  return {
    weights: Object.fromEntries(normalized.map((arm) => [armKey(arm), arm.weight])),
    updatedAt: new Date().toISOString(),
    changed: true,
    reason: null,
    arms: normalized.map(({rawWeight, ...arm}) => arm),
  };
}
