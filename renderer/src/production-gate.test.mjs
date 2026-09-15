import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateProductionPackage, validateWithSequenceRetry, parseSequenceReview, resolveReviewAssetPath, sequencePackageHash} from './production-gate.mjs';

const goodDialogue = Array.from({length: 6}, (_, i) => ({
  speaker: i % 2 ? 'stewie' : 'peter',
  text: `turn ${i}`,
  visuals: [{turn_index: i, phrase: `turn ${i}`}],
}));
const goodVisuals = Array.from({length: 8}, (_, i) => ({
  assetId: `asset-${i}`,
  assetUrl: `https://example.test/asset-${i}.png`,
  startTurn: i % 6,
  phrase: `turn ${i % 6}`,
  judgement: 'relevant and readable',
}));
const reviewFor = (dialogue = goodDialogue, visuals = goodVisuals) => ({
  passed: true,
  scores: {relevance: 4, coverage: 4, variety: 4, readability: 4, pacing: 4},
  provider: 'anthropic',
  packageHash: sequencePackageHash({dialogue, visuals}),
});

test('production gate accepts a complete judged package', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals, sequenceReview: reviewFor()});
  assert.deepEqual(result, {ok: true, errors: []});
});

test('production gate rejects unjudged or incomplete visuals', () => {
  const visuals = goodVisuals.slice(0, 7);
  const result = validateProductionPackage({dialogue: goodDialogue, visuals, sequenceReview: reviewFor(goodDialogue, visuals)});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_PREFLIGHT_FAILED:7_DISTINCT_IMAGES'));
});

test('production gate rejects a failed sequence review', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals, sequenceReview: {...reviewFor(), passed: false}});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('SEQUENCE_REVIEW_FAILED'));
});

test('a sequence-only failure rediscovers the complete visual package once', async () => {
  const replacementVisuals = goodVisuals.map((visual, index) => ({...visual, assetId:`replacement-${index}`, assetUrl:`https://example.test/replacement-${index}.png`}));
  const result = await validateWithSequenceRetry(
    {dialogue:goodDialogue, visuals:goodVisuals},
    {
      reviewSequence: async packageInput => packageInput.visuals === goodVisuals
        ? {...reviewFor(goodDialogue, goodVisuals), passed:false, scores:{relevance:2, coverage:1, variety:2, readability:1, pacing:1}}
        : reviewFor(goodDialogue, replacementVisuals),
      rediscover: async packageInput => ({...packageInput, visuals:replacementVisuals}),
    },
  );
  assert.equal(result.ok,true);
  assert.equal(result.sequenceRegenerated,true);
  assert.equal(result.visuals[0].assetId,'replacement-0');
});

test('production gate rejects stale or self-attested reviews', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals, sequenceReview: {passed: true}});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('SEQUENCE_REVIEW_INVALID'));
});

test('production gate validates selected visual anchors against the n8n dialogue shape', () => {
  const visuals = goodVisuals.map((visual, index) => ({...visual, phrase: index === 0 ? 'missing phrase' : `turn ${visual.startTurn}`}));
  const result = validateProductionPackage({dialogue: goodDialogue, visuals, sequenceReview: reviewFor(goodDialogue, visuals)});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_ANCHOR_MISSING:0'));
});

test('production gate requires an explicit sequence review result', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('SEQUENCE_REVIEW_REQUIRED'));
});

test('sequence review parser accepts bounded multimodal scores', () => {
  const review = parseSequenceReview(JSON.stringify({relevance: 4, coverage: 5, variety: 3, readability: 4, pacing: 4, reason: 'clear'}));
  assert.equal(review.passed, true);
  assert.equal(review.scores.coverage, 5);
});

test('sequence review parser fails closed on malformed or weak output', () => {
  assert.equal(parseSequenceReview('not json').passed, false);
  assert.equal(parseSequenceReview(JSON.stringify({relevance: 5, coverage: 5, variety: 2, readability: 5, pacing: 5})).passed, false);
});

test('review asset paths map media URLs into the configured root and block traversal', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-path-test-'));
  const mediaRoot = path.join(temporaryDirectory, 'media');
  const imagePath = path.join(mediaRoot, 'visuals/run/image.png');
  await fs.mkdir(path.dirname(imagePath), {recursive: true});
  await fs.writeFile(imagePath, 'image');
  try {
    assert.equal(await resolveReviewAssetPath('/media/visuals/run/image.png', mediaRoot), await fs.realpath(imagePath));
    await assert.rejects(resolveReviewAssetPath('../secret.png', mediaRoot), /SEQUENCE_REVIEW_INVALID_ASSET/);
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
});

test('review asset paths reject symlinks that escape the configured root', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-symlink-test-'));
  const mediaRoot = path.join(temporaryDirectory, 'media');
  const outside = path.join(temporaryDirectory, 'outside.png');
  const link = path.join(mediaRoot, 'visuals/escaped.png');
  await fs.mkdir(path.dirname(link), {recursive: true});
  await fs.writeFile(outside, 'secret');
  await fs.symlink(outside, link);
  try {
    await assert.rejects(resolveReviewAssetPath('/media/visuals/escaped.png', mediaRoot), /SEQUENCE_REVIEW_INVALID_ASSET/);
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
});

test('production gate does not coerce null or empty visual turns to turn zero', () => {
  for (const invalid of [null, '', undefined, '0']) {
    const visuals = goodVisuals.map(visual => ({...visual}));
    visuals[0].startTurn = invalid;
    const result = validateProductionPackage({dialogue: goodDialogue, visuals, sequenceReview: reviewFor(goodDialogue, visuals)});
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('VISUAL_ANCHOR_MISSING:INVALID'));
  }
});
