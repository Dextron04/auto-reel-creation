import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildDistributionReport, writeDistributionReport, readDistributionReport, attachNarrative} from './distribution-report.mjs';

async function tempMediaDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'distribution-report-'));
}

const sampleWeightResult = {
  updatedAt: '2026-09-18T04:00:00.000Z',
  changed: true,
  reason: null,
  arms: [
    {slug: 'git-cli', format: 'tips', sampleCount: 4, avgEngagementRate: 0.2, weight: 0.18, previousWeight: 0.1, zScore: 1.3, multiplier: 1.6},
    {slug: 'editor-ide', format: 'tips', sampleCount: 4, avgEngagementRate: 0.02, weight: 0.06, previousWeight: 0.1, zScore: -1.1, multiplier: 0.7},
    {slug: 'databases-performance', format: 'trend', sampleCount: 0, avgEngagementRate: 0, weight: 0.1, previousWeight: 0.1, zScore: null, multiplier: 1},
  ],
};

test('buildDistributionReport ranks arms with a real zScore and leaves samples-less arms out of the leaderboard', () => {
  const report = buildDistributionReport({date: '2026-09-18', weightResult: sampleWeightResult});
  assert.equal(report.date, '2026-09-18');
  assert.equal(report.weightsChanged, true);
  assert.equal(report.topPerformer.slug, 'git-cli');
  assert.equal(report.bottomPerformer.slug, 'editor-ide');
  assert.equal(report.leaderboard.length, 2);
  assert.equal(report.arms.length, 3, 'full arm table is preserved even though the leaderboard is filtered');
  assert.equal(report.narrative, null);
});

test('buildDistributionReport rejects a malformed date', () => {
  assert.throws(() => buildDistributionReport({date: 'not-a-date', weightResult: sampleWeightResult}), /DISTRIBUTION_REPORT_DATE_INVALID/);
});

test('writeDistributionReport then readDistributionReport round-trips', async () => {
  const mediaDir = await tempMediaDir();
  const report = buildDistributionReport({date: '2026-09-18', weightResult: sampleWeightResult});
  await writeDistributionReport({date: '2026-09-18', report}, mediaDir);
  const read = await readDistributionReport('2026-09-18', mediaDir);
  assert.deepEqual(read, report);
});

test('readDistributionReport rejects a path-traversal date instead of touching the filesystem', async () => {
  const mediaDir = await tempMediaDir();
  await assert.rejects(() => readDistributionReport('../../etc/passwd', mediaDir), /DISTRIBUTION_REPORT_DATE_INVALID/);
});

test('readDistributionReport reports a clean not-found error for a date with no report yet', async () => {
  const mediaDir = await tempMediaDir();
  await assert.rejects(() => readDistributionReport('2026-01-01', mediaDir), /DISTRIBUTION_REPORT_NOT_FOUND:2026-01-01/);
});

test('attachNarrative merges a narrative into an already-written report', async () => {
  const mediaDir = await tempMediaDir();
  const report = buildDistributionReport({date: '2026-09-18', weightResult: sampleWeightResult});
  await writeDistributionReport({date: '2026-09-18', report}, mediaDir);
  const updated = await attachNarrative({date: '2026-09-18', narrative: 'Git & CLI Tricks: Tips clearly won today.'}, mediaDir);
  assert.equal(updated.narrative, 'Git & CLI Tricks: Tips clearly won today.');
  assert.equal(updated.narrativeSource, 'claude');
  const reread = await readDistributionReport('2026-09-18', mediaDir);
  assert.equal(reread.narrative, 'Git & CLI Tricks: Tips clearly won today.');
});

test('attachNarrative rejects an empty narrative', async () => {
  const mediaDir = await tempMediaDir();
  const report = buildDistributionReport({date: '2026-09-18', weightResult: sampleWeightResult});
  await writeDistributionReport({date: '2026-09-18', report}, mediaDir);
  await assert.rejects(() => attachNarrative({date: '2026-09-18', narrative: '   '}, mediaDir), /DISTRIBUTION_REPORT_NARRATIVE_REQUIRED/);
});
