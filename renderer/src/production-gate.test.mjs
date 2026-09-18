import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProductionPackage} from './production-gate.mjs';

const goodDialogue = Array.from({length: 6}, (_, i) => ({
  speaker: i % 2 ? 'stewie' : 'peter',
  text: `turn ${i}`,
}));
const goodVisuals = Array.from({length: 8}, (_, i) => ({
  assetId: `asset-${i}`,
  assetUrl: `https://example.test/asset-${i}.png`,
  startTurn: i % 6,
  phrase: `turn ${i % 6}`,
  judgement: 'relevant and readable',
}));

test('production gate accepts a complete package', () => {
  const result = validateProductionPackage({dialogue: goodDialogue, visuals: goodVisuals});
  assert.deepEqual(result, {ok: true, errors: []});
});

test('production gate rejects unjudged or incomplete visuals', () => {
  const visuals = goodVisuals.slice(0, 5);
  const result = validateProductionPackage({dialogue: goodDialogue, visuals});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_PREFLIGHT_FAILED:5_DISTINCT_IMAGES'));
});

test('production gate rejects a visual with no phrase', () => {
  const visuals = goodVisuals.map((visual, index) => ({...visual, phrase: index === 0 ? '' : visual.phrase}));
  const result = validateProductionPackage({dialogue: goodDialogue, visuals});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_ANCHOR_MISSING:0'));
});

test('production gate does not require a visual phrase to literally match its turn text', () => {
  // Dialogue-writing paraphrase drift (a pause, a verb tense, a phrase pulled from source
  // material rather than the line itself) is expected and handled downstream by
  // buildVisualTimeline's turn-start fallback, not enforced as a hard gate here.
  const visuals = goodVisuals.map(visual => visual.startTurn === 1 ? {...visual, phrase: 'a phrase that paraphrases the idea rather than quoting it'} : visual);
  const result = validateProductionPackage({dialogue: goodDialogue, visuals});
  assert.ok(!result.errors.some(e => e.startsWith('VISUAL_ANCHOR_MISSING')));
});

test('production gate does not coerce null or empty visual turns to turn zero', () => {
  for (const invalid of [null, '', undefined, '0']) {
    const visuals = goodVisuals.map(visual => ({...visual}));
    visuals[0].startTurn = invalid;
    const result = validateProductionPackage({dialogue: goodDialogue, visuals});
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('VISUAL_ANCHOR_MISSING:INVALID'));
  }
});
