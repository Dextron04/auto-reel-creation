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
  const visuals = goodVisuals.slice(0, 7);
  const result = validateProductionPackage({dialogue: goodDialogue, visuals});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_PREFLIGHT_FAILED:7_DISTINCT_IMAGES'));
});

test('production gate validates selected visual anchors against the n8n dialogue shape', () => {
  const visuals = goodVisuals.map((visual, index) => ({...visual, phrase: index === 0 ? 'missing phrase' : `turn ${visual.startTurn}`}));
  const result = validateProductionPackage({dialogue: goodDialogue, visuals});
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('VISUAL_ANCHOR_MISSING:0'));
});

test('production gate tolerates a phrase separated by a dialogue pause', () => {
  const dialogue = goodDialogue.map((turn, i) => i === 1 ? {...turn, text: "myc just... stops that from happening"} : turn);
  const visuals = goodVisuals.map(visual => visual.startTurn === 1 ? {...visual, phrase: 'myc just stops that from happening'} : visual);
  const result = validateProductionPackage({dialogue, visuals});
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
