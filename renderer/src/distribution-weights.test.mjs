import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARMS,
  DEFAULT_WEIGHT,
  armKey,
  defaultWeights,
  readWeights,
  writeWeights,
  engagementRate,
  summarizeArmPerformance,
  computeWeights,
} from './distribution-weights.mjs';

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'distribution-weights-'));
  return path.join(dir, 'distribution-weights.json');
}

test('ARMS covers exactly 5 topics x 2 formats and defaultWeights sums to 1', () => {
  assert.equal(ARMS.length, 10);
  const weights = defaultWeights();
  assert.equal(Object.keys(weights).length, 10);
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(weights[armKey({slug: 'git-cli', format: 'tips'})], DEFAULT_WEIGHT);
});

test('readWeights bootstraps uniform defaults when no file exists yet', async () => {
  const result = await readWeights(await tempPath());
  assert.deepEqual(result.weights, defaultWeights());
  assert.equal(result.updatedAt, null);
});

test('writeWeights then readWeights round-trips', async () => {
  const weightsPath = await tempPath();
  const custom = {...defaultWeights(), [armKey({slug: 'git-cli', format: 'tips'})]: 0.2};
  await writeWeights({weights: custom, updatedAt: '2026-09-17T00:00:00.000Z'}, weightsPath);
  const result = await readWeights(weightsPath);
  assert.equal(result.weights[armKey({slug: 'git-cli', format: 'tips'})], 0.2);
  assert.equal(result.updatedAt, '2026-09-17T00:00:00.000Z');
});

test('engagementRate divides interaction total by reach, falling back to plays then total_interactions', () => {
  assert.equal(engagementRate({likes: 100, comments: 10, shares: 5, saved: 5, reach: 1000}), 0.12);
  assert.equal(engagementRate({likes: 10, plays: 100}), 0.1);
  assert.equal(engagementRate({likes: 5, total_interactions: 50}), 0.1);
  assert.equal(engagementRate({}), 0);
});

test('summarizeArmPerformance averages engagement per arm, skips missing insights and stale entries', () => {
  const now = new Date('2026-09-18T00:00:00.000Z');
  const log = [
    {topicSlug: 'git-cli', format: 'tips', mediaId: 'a', publishedAt: '2026-09-17T00:00:00.000Z'},
    {topicSlug: 'git-cli', format: 'tips', mediaId: 'b', publishedAt: '2026-09-16T00:00:00.000Z'},
    {topicSlug: 'git-cli', format: 'tips', mediaId: 'stale', publishedAt: '2026-01-01T00:00:00.000Z'},
    {topicSlug: 'git-cli', format: 'tips', mediaId: 'no-insight', publishedAt: '2026-09-17T00:00:00.000Z'},
  ];
  const insightsByMediaId = {
    a: {likes: 100, reach: 1000},
    b: {likes: 50, reach: 1000},
    stale: {likes: 999, reach: 1},
  };
  const stats = summarizeArmPerformance({log, insightsByMediaId, windowDays: 30, now});
  const gitCliTips = stats.find((s) => s.slug === 'git-cli' && s.format === 'tips');
  assert.equal(gitCliTips.sampleCount, 2);
  assert.ok(Math.abs(gitCliTips.avgEngagementRate - 0.075) < 1e-9);
  assert.equal(gitCliTips.totalReach, 2000);
  const untouched = stats.find((s) => s.slug === 'editor-ide' && s.format === 'trend');
  assert.equal(untouched.sampleCount, 0);
  assert.equal(untouched.avgEngagementRate, 0);
});

test('computeWeights keeps previous weights unchanged when fewer than 2 arms have enough samples', () => {
  const previousWeights = defaultWeights();
  const stats = [{slug: 'git-cli', format: 'tips', sampleCount: 5, avgEngagementRate: 0.5, totalReach: 5000}];
  const result = computeWeights({stats, previousWeights, minSamples: 2});
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'INSUFFICIENT_SAMPLES');
  assert.deepEqual(result.weights, previousWeights);
});

function fullStats(overrides) {
  const byKey = new Map(overrides.map((s) => [armKey(s), s]));
  return ARMS.map((arm) => byKey.get(armKey(arm)) ?? {...arm, sampleCount: 0, avgEngagementRate: 0, totalReach: 0});
}

test('computeWeights raises the over-performing arm and lowers the under-performing one, still summing to 1', () => {
  const previousWeights = defaultWeights();
  const stats = fullStats([
    {slug: 'git-cli', format: 'tips', sampleCount: 3, avgEngagementRate: 0.20, totalReach: 9000},
    {slug: 'editor-ide', format: 'tips', sampleCount: 3, avgEngagementRate: 0.02, totalReach: 9000},
    {slug: 'databases-performance', format: 'tips', sampleCount: 3, avgEngagementRate: 0.08, totalReach: 9000},
  ]);
  const result = computeWeights({stats, previousWeights, minSamples: 2});
  assert.equal(result.changed, true);
  const total = Object.values(result.weights).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  const gitCli = result.weights[armKey({slug: 'git-cli', format: 'tips'})];
  const editorIde = result.weights[armKey({slug: 'editor-ide', format: 'tips'})];
  assert.ok(gitCli > previousWeights[armKey({slug: 'git-cli', format: 'tips'})], 'top performer weight should rise');
  assert.ok(editorIde < previousWeights[armKey({slug: 'editor-ide', format: 'tips'})], 'bottom performer weight should fall');
  assert.ok(gitCli > editorIde);
  const untouchedArm = result.arms.find((a) => a.slug === 'git-cli' && a.format === 'trend');
  assert.equal(untouchedArm.multiplier, 1, 'an arm with no samples this window must not be penalized or boosted');
});

test('computeWeights clamps each arm before renormalizing, so an extreme z-score cannot zero out or fully dominate the roster', () => {
  const previousWeights = defaultWeights();
  const stats = [
    {slug: 'git-cli', format: 'tips', sampleCount: 10, avgEngagementRate: 1.0, totalReach: 100000},
    {slug: 'editor-ide', format: 'tips', sampleCount: 10, avgEngagementRate: 0.001, totalReach: 100000},
  ];
  const result = computeWeights({stats, previousWeights, minSamples: 2, minWeight: 0.04, maxWeight: 0.30});
  const gitCliArm = result.arms.find((a) => a.slug === 'git-cli' && a.format === 'tips');
  const editorIdeArm = result.arms.find((a) => a.slug === 'editor-ide' && a.format === 'tips');
  assert.ok(editorIdeArm.weight > 0, 'a poor performer must keep a nonzero shot at being picked');
  assert.ok(gitCliArm.weight < 1, 'a strong performer must not take the entire roster');
  assert.ok(gitCliArm.weight > editorIdeArm.weight);
});
