import assert from 'node:assert/strict';
import test from 'node:test';
import * as renderer from './render-report.mjs';

test('render report exposes timing and overlay coverage for end-to-end verification', () => {
  assert.equal(typeof renderer.createRenderReport, 'function');
  const report = renderer.createRenderReport({
    durationInFrames: 1582,
    playbackRate: 1,
    captions: [{text: 'hello'}],
    characterSegments: [{speaker: 'peter'}, {speaker: 'stewie'}],
    visuals: [{imagePath: '/media/one.png', start: 0, end: 20}, {imagePath: '/media/two.png', start: 20, end: 52.72}],
    audioSegments: [{start: 0, end: 52.72, playbackRate: 1}],
  }, '/output/reel-test.mp4');

  assert.deepEqual(report, {
    outputLocation: '/output/reel-test.mp4',
    durationInFrames: 1582,
    durationSeconds: 1582 / 30,
    playbackRate: 1,
    audioEndSeconds: 52.72,
    captionCount: 1,
    characterSegmentCount: 2,
    visualCount: 2,
    visualPaths: ['/media/one.png', '/media/two.png'],
    visualCoverageSeconds: 52.72,
  });
});
