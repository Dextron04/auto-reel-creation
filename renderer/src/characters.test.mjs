import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCharacterSegments} from './characters.mjs';
import {validateRenderRequest} from './validation.mjs';

test('character overlay switches with each dialogue speaker', () => {
  const segments = buildCharacterSegments([
    {speaker: 'peter', start: 0, end: 4},
    {speaker: 'stewie', start: 4, end: 7},
    {speaker: 'peter', start: 7, end: 10},
  ], {peter: '/media/peter.png', stewie: '/media/stewie.png'});

  assert.deepEqual(segments.map(({speaker, imagePath, start, end}) => ({speaker, imagePath, start, end})), [
    {speaker: 'peter', imagePath: '/media/peter.png', start: 0, end: 4},
    {speaker: 'stewie', imagePath: '/media/stewie.png', start: 4, end: 7},
    {speaker: 'peter', imagePath: '/media/peter.png', start: 7, end: 10},
  ]);
});

test('character overlay skips speakers without an image', () => {
  const segments = buildCharacterSegments([{speaker: 'peter', start: 0, end: 4}], {});
  assert.deepEqual(segments, []);
});

test('render validation confines character images to the media folder', () => {
  const request = validateRenderRequest({sourceVideo: '/media/source.mp4', characterImages: {peter: '/media/peter.png', stewie: '/media/stewie.png'}});
  assert.equal(request.characterImages.peter, '/media/peter.png');
  assert.throws(() => validateRenderRequest({sourceVideo: '/media/source.mp4', characterImages: {peter: '/tmp/peter.png'}}), /MEDIA_PATH_OUTSIDE_ROOT/);
});
