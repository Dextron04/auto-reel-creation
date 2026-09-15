const SCENE_TYPES = new Set(['static', 'screenshot-focus', 'terminal-demo', 'connected-workflow', 'metric-counter']);
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function resolveSceneType(visual = {}) {
  const requested = String(visual.scene_type ?? visual.sceneType ?? '').trim().toLowerCase();
  if (SCENE_TYPES.has(requested)) return requested;
  const purpose = String(visual.visual_purpose ?? visual.visualPurpose ?? '').trim().toLowerCase();
  return ({interface: 'screenshot-focus', mechanism: 'connected-workflow', evidence: 'metric-counter', outcome: 'metric-counter'})[purpose] ?? 'static';
}

export function sceneMotion(visual = {}, frame = 0, fps = 30) {
  const type = resolveSceneType(visual);
  const t = Math.max(0, Number(frame) / Math.max(1, Number(fps)));
  const progress = clamp(t / Math.max(0.01, Number(visual.motion_duration ?? 3)));
  const eased = progress * progress * (3 - 2 * progress);
  if (type === 'terminal-demo') return {transform: `translateY(${Math.round((1 - eased) * 28)}px) scale(${(0.94 + eased * 0.06).toFixed(4)})`, filter: `contrast(${(0.92 + eased * 0.08).toFixed(3)})`};
  if (type === 'connected-workflow') return {transform: `translateX(${Math.round((1 - eased) * -36)}px) scale(${(0.9 + eased * 0.1).toFixed(4)})`, filter: `saturate(${(0.75 + eased * 0.25).toFixed(3)})`};
  if (type === 'metric-counter') return {transform: `scale(${(0.86 + eased * 0.14).toFixed(4)})`, filter: `brightness(${(0.8 + eased * 0.2).toFixed(3)})`};
  if (type === 'screenshot-focus') return {transform: `scale(${(0.96 + eased * 0.04).toFixed(4)})`, filter: 'drop-shadow(0 14px 22px rgba(0,0,0,.46))'};
  const durationFrames = Math.max(2, Math.ceil(((Number(visual.end) - Number(visual.start)) || Number(visual.motion_duration) || 3) * Math.max(1, Number(fps))));
  const edge = Math.min(6, durationFrames / 3);
  const boundedFrame = clamp(Number(frame), 0, durationFrames);
  const staticScale = boundedFrame <= edge
    ? 0.96 + (boundedFrame / edge) * 0.04
    : 1 + ((boundedFrame - edge) / (durationFrames - edge)) * 0.035;
  return {transform: `scale(${staticScale.toFixed(4)})`, filter: 'drop-shadow(0 12px 18px rgba(0,0,0,.4))'};
}
