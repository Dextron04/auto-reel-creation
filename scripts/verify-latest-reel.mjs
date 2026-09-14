import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const outputRoot = path.resolve('output');
const files = await fs.readdir(outputRoot);
const reports = [];
for (const name of files.filter(name => name.endsWith('.mp4.json'))) {
  const reportPath = path.join(outputRoot, name);
  const stat = await fs.stat(reportPath);
  reports.push({reportPath, mtimeMs: stat.mtimeMs});
}
assert.ok(reports.length, 'no completed reel report exists');
reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
const report = JSON.parse(await fs.readFile(reports[0].reportPath, 'utf8'));
const videoPath = path.resolve(report.outputLocation.replace(/^\/output\//, 'output/'));
const {stdout} = await execFileAsync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', videoPath,
]);
const probe = JSON.parse(stdout);
const video = probe.streams.find(stream => stream.codec_type === 'video');
const audio = probe.streams.find(stream => stream.codec_type === 'audio');
const measuredDuration = Number(probe.format.duration);

assert.equal(video?.width, 1080);
assert.equal(video?.height, 1920);
assert.ok(audio, 'rendered reel has no audio stream');
assert.equal(report.playbackRate, 1);
assert.ok(report.durationSeconds >= 30 && report.durationSeconds <= 60);
assert.ok(Math.abs(measuredDuration - report.durationSeconds) < 0.2, `container duration ${measuredDuration} differs from report ${report.durationSeconds}`);
assert.ok(report.durationSeconds - report.audioEndSeconds < 0.05 || report.durationSeconds === 30, 'reel has an unnecessary tail after dialogue');
assert.ok(report.captionCount >= 6, `expected subtitles, found ${report.captionCount}`);
assert.equal(report.characterSegmentCount, 6);
assert.ok(report.visualCount >= 4, `expected at least 4 topic visuals, found ${report.visualCount}`);
assert.ok(new Set(report.visualPaths).size >= 4, 'expected at least 4 distinct topic visual PNGs');
assert.ok(report.visualCoverageSeconds >= report.audioEndSeconds * 0.9, `visuals cover ${report.visualCoverageSeconds}s of ${report.audioEndSeconds}s dialogue`);

console.log('end-to-end reel verification passed');
