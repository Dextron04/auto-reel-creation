import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const activeOutputPaths = new Set();

export async function withActiveOutput(outputPath, work) {
  const resolved = path.resolve(outputPath);
  activeOutputPaths.add(resolved);
  try {
    return await work();
  } finally {
    activeOutputPaths.delete(resolved);
  }
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeOrIgnoreMissing(file, options) {
  try {
    if (options) await fs.rm(file, options);
    else await fs.unlink(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function entriesOrEmpty(directory) {
  try {
    return await fs.readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function pruneGeneratedMedia({mediaRoot, outputRoot, retentionDays = 14, now = new Date()} = {}) {
  const days = Number(String(retentionDays).trim() === '' ? 14 : retentionDays);
  if (!Number.isFinite(days) || days < 0) throw new Error('INVALID_GENERATED_MEDIA_RETENTION_DAYS');
  const result = {visualRunsRemoved: 0, outputFilesRemoved: 0};
  if (days === 0) return result;
  const cutoff = new Date(now).getTime() - days * DAY_MS;
  if (!Number.isFinite(cutoff)) throw new Error('INVALID_RETENTION_CLOCK');

  const visualRoot = path.join(mediaRoot, 'visuals');
  for (const entry of await entriesOrEmpty(visualRoot)) {
    if (!entry.isDirectory()) continue;
    const runDirectory = path.join(visualRoot, entry.name);
    const runStat = await statOrNull(runDirectory);
    if (!runStat || runStat.mtimeMs >= cutoff) continue;
    if (await removeOrIgnoreMissing(runDirectory, {recursive: true})) result.visualRunsRemoved += 1;
  }

  for (const entry of await entriesOrEmpty(outputRoot)) {
    if (!entry.isFile() || (!entry.name.endsWith('.mp4') && !entry.name.endsWith('.mp4.json'))) continue;
    const outputFile = path.join(outputRoot, entry.name);
    const protectedVideo = path.resolve(entry.name.endsWith('.mp4.json') ? outputFile.slice(0, -5) : outputFile);
    if (activeOutputPaths.has(protectedVideo)) continue;
    const outputStat = await statOrNull(outputFile);
    if (!outputStat || outputStat.mtimeMs >= cutoff || activeOutputPaths.has(protectedVideo)) continue;
    if (await removeOrIgnoreMissing(outputFile)) result.outputFilesRemoved += 1;
  }

  return result;
}
