import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function reportDir(mediaDir) {
  return path.join(mediaDir, 'distribution-reports');
}

function reportPath(date, mediaDir) {
  if (!SAFE_DATE.test(date)) throw new Error('DISTRIBUTION_REPORT_DATE_INVALID');
  return path.join(reportDir(mediaDir), `${date}.json`);
}

// Structures the picker's raw weight-update output into the shape the daily n8n report reads: a
// ranked leaderboard (only arms with enough samples to call a real result) plus the full weight
// delta table so every arm's move is visible, not just the extremes.
export function buildDistributionReport({date, weightResult}) {
  if (!SAFE_DATE.test(String(date ?? ''))) throw new Error('DISTRIBUTION_REPORT_DATE_INVALID');
  const arms = weightResult.arms ?? [];
  const ranked = arms
    .filter((arm) => arm.zScore !== null && arm.zScore !== undefined)
    .sort((a, b) => b.zScore - a.zScore);
  return {
    date,
    generatedAt: weightResult.updatedAt,
    weightsChanged: weightResult.changed,
    skipReason: weightResult.reason ?? null,
    topPerformer: ranked[0] ?? null,
    bottomPerformer: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    leaderboard: ranked,
    arms,
    narrative: null,
    narrativeSource: null,
  };
}

export async function writeDistributionReport({date, report}, mediaDir = process.env.MEDIA_ROOT ?? '/media') {
  const target = reportPath(date, mediaDir);
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temporaryPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(report, null, 2));
  await fs.rename(temporaryPath, target);
  return target;
}

export async function readDistributionReport(date, mediaDir = process.env.MEDIA_ROOT ?? '/media') {
  try {
    const raw = await fs.readFile(reportPath(date, mediaDir), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`DISTRIBUTION_REPORT_NOT_FOUND:${date}`);
    throw error;
  }
}

export async function attachNarrative({date, narrative, narrativeSource = 'claude'}, mediaDir = process.env.MEDIA_ROOT ?? '/media') {
  if (!String(narrative ?? '').trim()) throw new Error('DISTRIBUTION_REPORT_NARRATIVE_REQUIRED');
  const report = await readDistributionReport(date, mediaDir);
  report.narrative = String(narrative).trim();
  report.narrativeSource = narrativeSource;
  await writeDistributionReport({date, report}, mediaDir);
  return report;
}
