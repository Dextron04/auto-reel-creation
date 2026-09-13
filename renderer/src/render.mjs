import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {validateRenderRequest, OUTPUT_ROOT} from './validation.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildDialogueTimeline} from './dialogue.mjs';
import {buildVisualTimeline} from './visuals.mjs';
import {buildCharacterSegments} from './characters.mjs';

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE ?? '/usr/bin/chromium';
const execFileAsync = promisify(execFile);

async function getAudioDurationSeconds(audioPath) {
  const {stdout} = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`INVALID_AUDIO_DURATION:${path.basename(audioPath)}`);
  return duration;
}

export async function renderReel(input) {
  let request = validateRenderRequest(input);
  if (request.dialogue.length) {
    const measuredDialogue = await Promise.all(request.dialogue.map(async (turn) => ({
      ...turn,
      durationSeconds: await getAudioDurationSeconds(turn.audioPath),
    })));
    const timeline = buildDialogueTimeline(measuredDialogue, {maxDurationSeconds: 29.5, maxWordsPerCaption: 4});
    request = {...request, ...timeline, dialogue: measuredDialogue, voiceOverlay: null};
  }
  request = {...request, visuals: buildVisualTimeline(request.visuals, {durationSeconds: request.durationInFrames/30, audioSegments: request.audioSegments, captions:request.captions})};
  request = {...request, characterSegments: buildCharacterSegments(request.audioSegments, request.characterImages)};
  await fs.mkdir(OUTPUT_ROOT, {recursive: true});
  const serveUrl = await bundle({entryPoint: path.resolve('src/index.jsx'), webpackOverride: (config) => config});
  const composition = await selectComposition({serveUrl, id: 'Reel', inputProps: request, browserExecutable});
  const outputLocation = path.join(OUTPUT_ROOT, `${input.jobId ?? `reel-${Date.now()}`}.mp4`);
  await renderMedia({composition: {...composition, durationInFrames: request.durationInFrames}, serveUrl, codec: 'h264', audioCodec: 'aac', outputLocation, inputProps: request, browserExecutable});
  return {outputLocation, width: 1080, height: 1920, fps: 30, durationInFrames: request.durationInFrames};
}

if (import.meta.url === `file://${process.argv[1]}`) renderReel(JSON.parse(process.argv[2] ?? '{}')).then(console.log).catch((error) => { console.error(error); process.exit(1); });
