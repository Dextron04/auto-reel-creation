import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProductionPackage, parseSequenceReview} from './production-gate.mjs';

const goodDialogue = Array.from({length: 6}, (_, i) => ({
  speaker: i % 2 ? 'stewie' : 'peter',
  text: `turn ${i}`,
  visuals: [{turn_index: i, phrase: `turn ${i}`}],
}));
const goodVisuals = Array.from({length: 8}, (_, i) => ({
  assetId: `asset-${i}`,
  assetUrl: `https://example.test/asset-${i}.png`,
  startTurn: i % 6,
  judgement: 'relevant and readable',
}));

test('production gate accepts a complete judged package', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals, sequenceReview: {passed: true}});
  assert.deepEqual(result, {ok: true, errors: []});
});

test('production gate rejects unjudged or incomplete visuals', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals.slice(0, 7), sequenceReview: {passed: true}});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_PREFLIGHT_FAILED:7_DISTINCT_IMAGES'));
});

test('production gate rejects a failed sequence review', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals, sequenceReview: {passed: false}});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('SEQUENCE_REVIEW_FAILED'));
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
