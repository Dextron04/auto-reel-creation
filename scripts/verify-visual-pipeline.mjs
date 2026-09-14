import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const mediaRoot = path.resolve('media');
const visualRoot = path.join(mediaRoot, 'visuals');
const runs = await fs.readdir(visualRoot, {withFileTypes: true});
const manifests = [];
for (const run of runs.filter(entry => entry.isDirectory())) {
  const manifestPath = path.join(visualRoot, run.name, 'manifest.json');
  try {
    const stat = await fs.stat(manifestPath);
    manifests.push({manifestPath, mtimeMs: stat.mtimeMs});
  } catch {}
}
assert.ok(manifests.length, 'no visual discovery manifest exists');
manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
const manifest = JSON.parse(await fs.readFile(manifests[0].manifestPath, 'utf8'));
assert.ok(manifest.visuals.length >= 4, `expected at least 4 visuals, found ${manifest.visuals.length}`);
assert.equal(new Set(manifest.visuals.map(visual => visual.imagePath)).size, manifest.visuals.length, 'every visual must be a distinct PNG');
assert.equal(new Set(manifest.visuals.map(visual => visual.assetUrl)).size, manifest.visuals.length, 'every visual must come from a distinct source asset');
assert.ok(new Set(manifest.visuals.map(visual => visual.startTurn)).size >= 4, 'visuals must cover at least 4 of the 6 dialogue turns');
for (const visual of manifest.visuals) {
  assert.ok(Number.isInteger(visual.startTurn) && visual.startTurn >= 0);
  assert.ok(String(visual.phrase || '').trim());
  const localPath = path.join(mediaRoot, visual.imagePath.replace(/^\/media\//, ''));
  const image = await fs.readFile(localPath);
  assert.ok(image.length > 1000, `${visual.imagePath} is unexpectedly small`);
  assert.equal(image.subarray(1, 4).toString(), 'PNG', `${visual.imagePath} is not a PNG`);
}

console.log('visual pipeline verification passed');
