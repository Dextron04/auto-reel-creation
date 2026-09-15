import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {chooseRandomStartFrame, validateRenderRequest, OUTPUT_ROOT} from './validation.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildDialogueTimeline, getReelDurationInFrames} from './dialogue.mjs';
import {buildVisualTimeline} from './visuals.mjs';
import {buildCharacterSegments} from './characters.mjs';
import {createRenderReport} from './render-report.mjs';

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE ?? '/usr/bin/chromium';
const execFileAsync = promisify(execFile);

async function getMediaDurationSeconds(mediaPath, invalidDurationError) {
  const {stdout} = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${invalidDurationError}:${path.basename(mediaPath)}`);
  return duration;
}

export async function renderReel(input) {
  const randomizeBackgroundStart = input.startFrame == null;
  let request = validateRenderRequest(input);
  if (request.dialogue.length) {
    const measuredDialogue = await Promise.all(request.dialogue.map(async (turn) => ({
      ...turn,
      durationSeconds: await getMediaDurationSeconds(turn.audioPath, 'INVALID_AUDIO_DURATION'),
    })));
    const timeline = buildDialogueTimeline(measuredDialogue, {maxDurationSeconds: 90, maxWordsPerCaption: 4});
    request = {
      ...request,
      ...timeline,
      durationInFrames: getReelDurationInFrames(timeline.durationSeconds, {maxDurationSeconds: 90}),
      dialogue: measuredDialogue,
      voiceOverlay: null,
    };
  }
  if (randomizeBackgroundStart) {
    const sourceDurationSeconds = await getMediaDurationSeconds(request.sourceVideo, 'INVALID_SOURCE_VIDEO_DURATION');
    request = {...request, startFrame: chooseRandomStartFrame(sourceDurationSeconds, request.durationInFrames)};
  }
  request = {...request, visuals: buildVisualTimeline(request.visuals, {durationSeconds: request.durationInFrames/30, audioSegments: request.audioSegments, captions:request.captions})};
  request = {...request, characterSegments: buildCharacterSegments(request.audioSegments, request.characterImages)};
  await fs.mkdir(OUTPUT_ROOT, {recursive: true});
  const serveUrl = await bundle({entryPoint: path.resolve('src/index.jsx'), webpackOverride: (config) => config});
  const composition = await selectComposition({serveUrl, id: 'Reel', inputProps: request, browserExecutable});
  const outputLocation = path.join(OUTPUT_ROOT, `${input.jobId ?? `reel-${Date.now()}`}.mp4`);
  // ponytail: Remotion defaults concurrency to roughly half the visible CPU cores, each a full
  // headless Chromium tab compositing a 1080x1920 frame — on this host that multiplication (not
  // ffmpeg, not Node) is what pushed the container into an OS-level OOM kill of a sibling
  // container sharing the same Docker VM memory ceiling. Single-threaded render is slower but
  // bounded; raise this once the host has real memory headroom to spare.
  const concurrency = Number(process.env.REMOTION_RENDER_CONCURRENCY || 1);
  await renderMedia({composition: {...composition, durationInFrames: request.durationInFrames}, serveUrl, codec: 'h264', audioCodec: 'aac', outputLocation, inputProps: request, browserExecutable, concurrency});
  const report = createRenderReport(request, outputLocation);
  const reportLocation = `${outputLocation}.json`;
  await fs.writeFile(reportLocation, JSON.stringify(report, null, 2));
  return {...report, reportLocation, width: 1080, height: 1920, fps: 30};
}

if (import.meta.url === `file://${process.argv[1]}`) renderReel(JSON.parse(process.argv[2] ?? '{}')).then(console.log).catch((error) => { console.error(error); process.exit(1); });
