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
  ], {durationSeconds: 29.5, audioSegments});

  assert.equal(visuals.length, 2);
  assert.equal(visuals[0].start, 0);
  assert.equal(visuals[0].end, 8);
  assert.equal(visuals[1].start, 8);
  assert.equal(visuals[1].end, 13);
});

test('visual URL validation only permits HTTPS images', () => {
  assert.equal(isSafeVisualUrl('https://example.com/logo.png'), true);
  assert.equal(isSafeVisualUrl('http://example.com/logo.png'), false);
  assert.equal(isSafeVisualUrl('file:///tmp/logo.png'), false);
});

test('visual timeline skips entries without a downloaded image', () => {
  assert.deepEqual(buildVisualTimeline([{kind: 'card', title: 'A useful tool'}]), []);
});

test('render validation resolves visual files inside the media root', () => {
  const request = validateRenderRequest({
    sourceVideo: '/media/source.mp4',
    visuals: [{title: 'DeepSeek', imagePath: '/media/visual-0-logo.png'}],
  });
  assert.equal(request.visuals[0].imagePath, '/media/visual-0-logo.png');
  assert.throws(() => validateRenderRequest({sourceVideo: '/media/source.mp4', visuals: [{imagePath: '/tmp/logo.png'}]}), /MEDIA_PATH_OUTSIDE_ROOT/);
});
