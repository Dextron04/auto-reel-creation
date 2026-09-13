const SPEAKERS = new Set(['peter', 'stewie']);

export function getActiveWordColor(speaker) {
  return speaker === 'stewie' ? '#FF3B30' : '#FFD60A';
}

export function buildDialogueTimeline(turns, {maxDurationSeconds = 29.5, maxWordsPerCaption = 4} = {}) {
  if (!Array.isArray(turns) || turns.length === 0) throw new Error('DIALOGUE_REQUIRED');
  const normalized = turns.map((turn, index) => {
    const speaker = String(turn.speaker ?? '').toLowerCase();
    if (!SPEAKERS.has(speaker)) throw new Error(`INVALID_DIALOGUE_SPEAKER:${index}`);
    const text = String(turn.text ?? '').replace(/\s+/g, ' ').trim();
    const durationSeconds = Number(turn.durationSeconds);
    if (!text) throw new Error(`DIALOGUE_TEXT_REQUIRED:${index}`);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`INVALID_DIALOGUE_DURATION:${index}`);
    return {...turn, speaker, text, durationSeconds};
  });

  const naturalDuration = normalized.reduce((sum, turn) => sum + turn.durationSeconds, 0);
  const playbackRate = Math.max(1, naturalDuration / maxDurationSeconds);
  const audioSegments = [];
  const captions = [];
  let cursor = 0;

  normalized.forEach((turn, turnIndex) => {
    const effectiveDuration = turn.durationSeconds / playbackRate;
    const end = naturalDuration > maxDurationSeconds && turnIndex === normalized.length - 1
      ? maxDurationSeconds
      : Math.min(maxDurationSeconds, cursor + effectiveDuration);
    audioSegments.push({speaker: turn.speaker, text: turn.text, audioPath: turn.audioPath, start: cursor, end, playbackRate});

    const words = turn.text.split(/\s+/).filter(Boolean);
    const weights = words.map((word) => Math.max(1, word.replace(/[^A-Za-z0-9]/g, '').length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let captionCursor = cursor;
    for (let offset = 0; offset < words.length; offset += maxWordsPerCaption) {
      const group = words.slice(offset, offset + maxWordsPerCaption);
      const groupWeights = weights.slice(offset, offset + maxWordsPerCaption);
      const groupWeight = groupWeights.reduce((sum, weight) => sum + weight, 0);
      const groupDuration = effectiveDuration * groupWeight / totalWeight;
      const captionEnd = Math.min(end, captionCursor + groupDuration);
      let tokenCursor = captionCursor;
      const tokens = group.map((text, groupIndex) => {
        const tokenDuration = groupDuration * groupWeights[groupIndex] / groupWeight;
        const token = {text, start: tokenCursor, end: Math.min(captionEnd, tokenCursor + tokenDuration)};
        tokenCursor += tokenDuration;
        return token;
      });
      captions.push({speaker: turn.speaker, text: group.join(' '), start: captionCursor, end: captionEnd, tokens});
      captionCursor = captionEnd;
    }
    cursor = end;
  });

  return {audioSegments, captions, playbackRate, durationSeconds: cursor};
}
