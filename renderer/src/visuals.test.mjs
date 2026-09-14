import assert from 'node:assert/strict';
import test from 'node:test';
import {buildVisualTimeline, isSafeVisualUrl} from './visuals.mjs';
import {validateRenderRequest} from './validation.mjs';

test('visual timeline aligns downloaded images to dialogue turns', () => {
  const audioSegments = [
    {start: 0, end: 4},
    {start: 4, end: 8},
    {start: 8, end: 13},
  ];
  const visuals = buildVisualTimeline([
    {kind: 'screenshot', title: 'Agent Kit', imagePath: '/media/visual-0-repo.png', startTurn: 0, endTurn: 1},
    {kind: 'logo', title: 'Developer workflow', imagePath: '/media/visual-1-logo.png', startTurn: 2, endTurn: 2},
  ], {durationSeconds: 60, audioSegments});

  assert.equal(visuals.length, 2);
  assert.equal(visuals[0].start, 0);
  assert.equal(visuals[0].end, 8);
  assert.equal(visuals[1].start, 8);
  assert.equal(visuals[1].end, 60);
});

test('visual URL validation only permits HTTPS images', () => {
  assert.equal(isSafeVisualUrl('https://example.com/logo.png'), true);
  assert.equal(isSafeVisualUrl('http://example.com/logo.png'), false);
  assert.equal(isSafeVisualUrl('file:///tmp/logo.png'), false);
});

test('visual timeline skips entries without a downloaded image', () => {
  assert.deepEqual(buildVisualTimeline([{kind: 'card', title: 'A useful tool'}]), []);
});

test('visual phrase matching survives punctuation attached to spoken words', () => {
  const captions = [{tokens: [
    {text: 'locked', start: 1, end: 1.4},
    {text: 'into', start: 1.4, end: 1.8},
    {text: 'that', start: 1.8, end: 2.2},
    {text: "vendor's", start: 2.2, end: 2.8},
    {text: 'SDK—and', start: 2.8, end: 3.5},
  ]}];
  const visuals = buildVisualTimeline([
    {imagePath: '/media/harness.png', startTurn: 0, phrase: "locked into that vendor's SDK"},
  ], {durationSeconds: 30, audioSegments: [{start: 0, end: 9}], captions});

  assert.equal(visuals.length, 1);
  assert.equal(visuals[0].start, 1);
});

test('visual cue falls back to its dialogue turn when Claude returns an inexact phrase', () => {
  const visuals = buildVisualTimeline([
    {imagePath: '/media/tool.png', startTurn: 1, phrase: 'slightly different wording'},
  ], {
    durationSeconds: 30,
    audioSegments: [{start: 0, end: 5}, {start: 5, end: 10}],
    captions: [{tokens: [{text: 'actual', start: 5, end: 6}, {text: 'dialogue', start: 6, end: 7}]}],
  });

  assert.equal(visuals.length, 1);
  assert.equal(visuals[0].start, 5);
  assert.equal(visuals[0].end, 30);
});

test('visuals sharing an anchor are spaced out and fill the reel to its end', () => {
  const visuals = buildVisualTimeline([
    {imagePath: '/media/one.png', startTurn: 0, phrase: 'missing one'},
    {imagePath: '/media/two.png', startTurn: 0, phrase: 'missing two'},
  ], {durationSeconds: 12, audioSegments: [{start: 0, end: 12}], captions: []});

  assert.equal(visuals.length, 2);
  assert.deepEqual(visuals.map(({start, end}) => [start, end]), [[0, 3], [3, 12]]);
});

test('render validation resolves visual files inside the media root', () => {
  const request = validateRenderRequest({
    sourceVideo: '/media/source.mp4',
    visuals: [{title: 'DeepSeek', imagePath: '/media/visual-0-logo.png'}],
  });
  assert.equal(request.visuals[0].imagePath, '/media/visual-0-logo.png');
  assert.throws(() => validateRenderRequest({sourceVideo: '/media/source.mp4', visuals: [{imagePath: '/tmp/logo.png'}]}), /MEDIA_PATH_OUTSIDE_ROOT/);
});

test('visuals cover the whole reel with no gaps between cues', () => {
  const audioSegments = Array.from({length: 6}, (_, i) => ({start: i * 8, end: i * 8 + 8}));
  const visuals = buildVisualTimeline(audioSegments.map((_, i) => ({imagePath: `/media/${i}.png`, startTurn: i})), {durationSeconds: 48, audioSegments});
  assert.equal(visuals.length, 6);
  assert.equal(visuals[0].start, 0);
  assert.ok(visuals.every((visual, i) => i === 0 || visual.start === visuals[i - 1].end));
  assert.equal(visuals.at(-1).end, 48);
});
