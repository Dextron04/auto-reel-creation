import assert from 'node:assert/strict';
import test from 'node:test';
import {buildDialogueTimeline, getActiveWordColor} from './dialogue.mjs';
import * as dialogueTools from './dialogue.mjs';
import {chooseRandomStartFrame, validateRenderRequest} from './validation.mjs';

const turns = [
  {speaker: 'peter', text: 'Developers meet this useful agent kit', audioPath: '/media/dialogue-0-peter.wav', durationSeconds: 6},
  {speaker: 'stewie', text: 'Why would anybody need it', audioPath: '/media/dialogue-1-stewie.wav', durationSeconds: 5},
  {speaker: 'peter', text: 'It connects tools in one workflow', audioPath: '/media/dialogue-2-peter.wav', durationSeconds: 6},
  {speaker: 'stewie', text: 'Can it prove useful though', audioPath: '/media/dialogue-3-stewie.wav', durationSeconds: 5},
  {speaker: 'peter', text: 'It removes repetitive integration work for developers', audioPath: '/media/dialogue-4-peter.wav', durationSeconds: 7},
  {speaker: 'stewie', text: 'That might actually save time', audioPath: '/media/dialogue-5-stewie.wav', durationSeconds: 5},
];

test('dialogue timeline is sequential and supports the 60 second ceiling', () => {
  const timeline = buildDialogueTimeline(turns, {maxDurationSeconds: 60, maxWordsPerCaption: 4});

  assert.equal(timeline.audioSegments.length, 6);
  assert.equal(timeline.audioSegments[0].start, 0);
  assert.equal(timeline.audioSegments[1].start, timeline.audioSegments[0].end);
  assert.equal(timeline.audioSegments.at(-1).end, 34);
  assert.equal(timeline.playbackRate, 1);
  assert.ok(timeline.captions.every((caption) => caption.text.split(/\s+/).length <= 4));
  assert.deepEqual([...new Set(timeline.captions.map((caption) => caption.speaker))], ['peter', 'stewie']);
});

test('active word color distinguishes Peter and Stewie', () => {
  assert.equal(getActiveWordColor('peter'), '#FFD60A');
  assert.equal(getActiveWordColor('stewie'), '#FF3B30');
});

test('dialogue timeline rejects an invalid speaker', () => {
  assert.throws(
    () => buildDialogueTimeline([{...turns[0], speaker: 'brian'}]),
    /INVALID_DIALOGUE_SPEAKER/,
  );
});

test('dialogue timeline rejects narration over one minute instead of accelerating it', () => {
  const longTurns = turns.map((turn) => ({...turn, durationSeconds: 11}));

  assert.throws(
    () => buildDialogueTimeline(longTurns, {maxDurationSeconds: 60}),
    /DIALOGUE_EXCEEDS_MAX_DURATION:66\.000/,
  );
});

test('render frame count follows natural dialogue with only a 30 second minimum', () => {
  assert.equal(typeof dialogueTools.getReelDurationInFrames, 'function');
  assert.equal(dialogueTools.getReelDurationInFrames(20), 900);
  assert.equal(dialogueTools.getReelDurationInFrames(52.72), 1582);
  assert.equal(dialogueTools.getReelDurationInFrames(60), 1800);
  assert.throws(() => dialogueTools.getReelDurationInFrames(60.01), /DIALOGUE_EXCEEDS_MAX_DURATION/);
});

test('render validation resolves every dialogue audio path inside media root', () => {
  const request = validateRenderRequest({
    sourceVideo: '/media/source.mp4',
    dialogue: turns.slice(0, 2),
  });

  assert.equal(request.dialogue[0].audioPath, '/media/dialogue-0-peter.wav');
  assert.throws(
    () => validateRenderRequest({sourceVideo: '/media/source.mp4', dialogue: [{...turns[0], audioPath: '/tmp/outside.wav'}]}),
    /MEDIA_PATH_OUTSIDE_ROOT/,
  );
});

test('background start selection stays inside the source video', () => {
  assert.equal(chooseRandomStartFrame(1140, 1800, {fps: 30, random: () => 0}), 0);
  assert.equal(chooseRandomStartFrame(1140, 1800, {fps: 30, random: () => 0.999999}), 32400);
});

test('background start selection uses zero when the source exactly fits the reel', () => {
  assert.equal(chooseRandomStartFrame(60, 1800, {fps: 30, random: () => 0.75}), 0);
});

test('background start selection rejects a source shorter than the reel', () => {
  assert.throws(
    () => chooseRandomStartFrame(59.9, 1800, {fps: 30, random: () => 0.5}),
    /SOURCE_VIDEO_TOO_SHORT/,
  );
});
