import assert from 'node:assert/strict';
import {buildDialogueTimeline, getReelDurationInFrames} from '../renderer/src/dialogue.mjs';

const durations = [9.12, 3.92, 14.4, 5.6, 14.32, 5.36];
const turns = durations.map((durationSeconds, index) => ({
  speaker: index % 2 === 0 ? 'peter' : 'stewie',
  text: `Natural dialogue turn number ${index + 1}`,
  audioPath: `/media/dialogue-${index}.wav`,
  durationSeconds,
}));
const timeline = buildDialogueTimeline(turns, {maxDurationSeconds: 60});

assert.equal(timeline.playbackRate, 1);
assert.ok(timeline.audioSegments.every(segment => segment.playbackRate === 1));
assert.ok(Math.abs(timeline.durationSeconds - 52.72) < 0.0001);
assert.equal(getReelDurationInFrames(timeline.durationSeconds), 1582);
assert.throws(
  () => buildDialogueTimeline(turns.map(turn => ({...turn, durationSeconds: 11})), {maxDurationSeconds: 60}),
  /DIALOGUE_EXCEEDS_MAX_DURATION/,
);

console.log('timing verification passed');
