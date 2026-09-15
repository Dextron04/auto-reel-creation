import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, stat, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as assetDiscovery from './asset-discovery.mjs';

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

test('generated-media pruning removes only expired visual runs and reel outputs', async () => {
  assert.equal(typeof assetDiscovery.pruneGeneratedMedia, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'reel-retention-'));
  const mediaRoot = path.join(root, 'media');
  const outputRoot = path.join(root, 'output');
  const oldRun = path.join(mediaRoot, 'visuals', 'old-run');
  const freshRun = path.join(mediaRoot, 'visuals', 'fresh-run');
  await mkdir(oldRun, {recursive: true});
  await mkdir(freshRun, {recursive: true});
  await mkdir(outputRoot, {recursive: true});

  const files = {
    oldImage: path.join(oldRun, 'asset.png'),
    freshImage: path.join(freshRun, 'asset.png'),
    source: path.join(mediaRoot, 'source.mp4'),
    oldVideo: path.join(outputRoot, 'old.mp4'),
    oldReport: path.join(outputRoot, 'old.mp4.json'),
    freshVideo: path.join(outputRoot, 'fresh.mp4'),
    unrelated: path.join(outputRoot, 'keep.txt'),
  };
  for (const file of Object.values(files)) await writeFile(file, file);
  const oldTime = new Date('2026-08-01T00:00:00Z');
  const freshTime = new Date('2026-09-14T00:00:00Z');
  for (const file of [files.oldImage, files.oldVideo, files.oldReport, files.source, files.unrelated]) await utimes(file, oldTime, oldTime);
  await utimes(oldRun, oldTime, oldTime);
  await utimes(files.freshImage, freshTime, freshTime);
  await utimes(freshRun, freshTime, freshTime);
  await utimes(files.freshVideo, freshTime, freshTime);

  const result = await assetDiscovery.pruneGeneratedMedia({
    mediaRoot,
    outputRoot,
    retentionDays: 14,
    now: new Date('2026-09-15T00:00:00Z'),
  });

  assert.deepEqual(result, {visualRunsRemoved: 1, outputFilesRemoved: 2});
  assert.equal(await exists(oldRun), false);
  assert.equal(await exists(files.oldVideo), false);
  assert.equal(await exists(files.oldReport), false);
  assert.equal(await exists(files.freshImage), true);
  assert.equal(await exists(files.freshVideo), true);
  assert.equal(await exists(files.source), true);
  assert.equal(await exists(files.unrelated), true);
  assert.match(await readFile(files.source, 'utf8'), /source\.mp4/);
});

test('zero retention days disables generated-media pruning', async () => {
  assert.equal(typeof assetDiscovery.pruneGeneratedMedia, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'reel-retention-disabled-'));
  const oldRun = path.join(root, 'media', 'visuals', 'old-run');
  await mkdir(oldRun, {recursive: true});
  await writeFile(path.join(oldRun, 'asset.png'), 'keep');

  const result = await assetDiscovery.pruneGeneratedMedia({
    mediaRoot: path.join(root, 'media'),
    outputRoot: path.join(root, 'output'),
    retentionDays: 0,
    now: new Date('2026-09-15T00:00:00Z'),
  });

  assert.deepEqual(result, {visualRunsRemoved: 0, outputFilesRemoved: 0});
  assert.equal(await exists(oldRun), true);
});

test('an empty retention setting uses the fourteen-day default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reel-retention-default-'));
  const oldRun = path.join(root, 'media', 'visuals', 'old-run');
  await mkdir(oldRun, {recursive: true});
  await writeFile(path.join(oldRun, 'asset.png'), 'old');
  await utimes(oldRun, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));

  const result = await assetDiscovery.pruneGeneratedMedia({
    mediaRoot: path.join(root, 'media'),
    outputRoot: path.join(root, 'output'),
    retentionDays: '',
    now: new Date('2026-09-15T00:00:00Z'),
  });

  assert.deepEqual(result, {visualRunsRemoved: 1, outputFilesRemoved: 0});
  assert.equal(await exists(oldRun), false);
});

test('concurrent pruning is idempotent when another cleanup removes the same files first', async () => {
  assert.equal(typeof assetDiscovery.pruneGeneratedMedia, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'reel-retention-race-'));
  const oldRun = path.join(root, 'media', 'visuals', 'old-run');
  const oldVideo = path.join(root, 'output', 'old.mp4');
  await mkdir(oldRun, {recursive: true});
  await mkdir(path.dirname(oldVideo), {recursive: true});
  await writeFile(path.join(oldRun, 'asset.png'), 'old');
  await writeFile(oldVideo, 'old');
  const oldTime = new Date('2026-08-01T00:00:00Z');
  await utimes(oldRun, oldTime, oldTime);
  await utimes(oldVideo, oldTime, oldTime);
  const options = {mediaRoot: path.join(root, 'media'), outputRoot: path.join(root, 'output'), retentionDays: 14, now: new Date('2026-09-15T00:00:00Z')};

  await assert.doesNotReject(() => Promise.all([
    assetDiscovery.pruneGeneratedMedia(options),
    assetDiscovery.pruneGeneratedMedia(options),
  ]));
  assert.equal(await exists(oldRun), false);
  assert.equal(await exists(oldVideo), false);
});

test('pruning never removes an output while that output is actively rendering', async () => {
  assert.equal(typeof assetDiscovery.withActiveOutput, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'reel-retention-active-'));
  const mediaRoot = path.join(root, 'media');
  const outputRoot = path.join(root, 'output');
  const oldVideo = path.join(outputRoot, 'active.mp4');
  const oldReport = `${oldVideo}.json`;
  await mkdir(outputRoot, {recursive: true});
  await writeFile(oldVideo, 'rendering');
  await writeFile(oldReport, 'report');
  const oldTime = new Date('2026-08-01T00:00:00Z');
  await utimes(oldVideo, oldTime, oldTime);
  await utimes(oldReport, oldTime, oldTime);

  await assetDiscovery.withActiveOutput(oldVideo, async () => {
    const result = await assetDiscovery.pruneGeneratedMedia({mediaRoot, outputRoot, retentionDays: 14, now: new Date('2026-09-15T00:00:00Z')});
    assert.deepEqual(result, {visualRunsRemoved: 0, outputFilesRemoved: 0});
    assert.equal(await exists(oldVideo), true);
    assert.equal(await exists(oldReport), true);
  });
});
