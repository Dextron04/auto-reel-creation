import path from 'node:path';

export const MEDIA_ROOT = process.env.MEDIA_ROOT ?? '/media';
export const OUTPUT_ROOT = process.env.OUTPUT_ROOT ?? '/output';

export function chooseRandomStartFrame(sourceDurationSeconds, reelDurationInFrames, {fps = 30, random = Math.random} = {}) {
  const sourceFrames = Math.floor(Number(sourceDurationSeconds) * fps);
  if (!Number.isFinite(sourceFrames) || sourceFrames <= 0) throw new Error('INVALID_SOURCE_VIDEO_DURATION');
  const maxStartFrame = sourceFrames - reelDurationInFrames;
  if (maxStartFrame < 0) {
    throw new Error(`SOURCE_VIDEO_TOO_SHORT:${sourceFrames}_FRAMES_FOR_${reelDurationInFrames}`);
  }

  const sample = Number(random());
  if (!Number.isFinite(sample)) throw new Error('INVALID_RANDOM_VALUE');
  const boundedSample = Math.min(Math.max(sample, 0), 1 - Number.EPSILON);
  return Math.min(maxStartFrame, Math.floor(boundedSample * (maxStartFrame + 1)));
}

export function resolveMediaPath(value, {optional = false} = {}) {
  if (!value && optional) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('MEDIA_PATH_REQUIRED');
  const candidate = path.resolve(MEDIA_ROOT, value.replace(/^\/media\/?/, ''));
  if (candidate !== MEDIA_ROOT && !candidate.startsWith(`${MEDIA_ROOT}${path.sep}`)) {
    throw new Error('MEDIA_PATH_OUTSIDE_ROOT');
  }
  return candidate;
}

export function validateRenderRequest(input) {
  const startFrame = Number(input.startFrame ?? 0);
  const durationInFrames = Number(input.durationInFrames ?? 900);
  if (!Number.isInteger(startFrame) || startFrame < 0) throw new Error('INVALID_START_FRAME');
  if (!Number.isInteger(durationInFrames) || durationInFrames <= 0 || durationInFrames > 1800) {
    throw new Error('INVALID_DURATION_FRAMES');
  }
  const dialogue = Array.isArray(input.dialogue)
    ? input.dialogue.map((turn) => ({...turn, audioPath: resolveMediaPath(turn.audioPath)}))
    : [];
  const visuals = Array.isArray(input.visuals)
    ? input.visuals.map((visual) => ({...visual, imagePath: resolveMediaPath(visual.imagePath)}))
    : [];
  const characterImages = Object.fromEntries(Object.entries(input.characterImages ?? {}).map(([speaker, imagePath]) => [speaker, resolveMediaPath(imagePath)]));
  return {
    ...input,
    startFrame,
    durationInFrames,
    dialogue,
    visuals,
    characterImages,
    sourceVideo: resolveMediaPath(input.sourceVideo),
    voiceOverlay: resolveMediaPath(input.voiceOverlay, {optional: true}),
    pngOverlay: resolveMediaPath(input.pngOverlay, {optional: true}),
  };
}
