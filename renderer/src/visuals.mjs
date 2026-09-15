export function isSafeVisualUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

const words = text => String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

// Dialogue often adds pauses ("myc just... stops") a phrase-extraction step strips, so this
// matches on the word sequence rather than raw text, same tolerance buildVisualTimeline uses
// below to anchor a cue in the captions.
export function phraseAnchorsTurn(text, phrase) {
  const turnWords = words(text);
  const phraseWords = words(phrase);
  if (!phraseWords.length) return false;
  return turnWords.some((_, i) => phraseWords.every((word, j) => turnWords[i + j] === word));
}

// Each visual starts at its spoken phrase (or its turn) and stays on screen until the next cue, so the reel is never blank.
export function buildVisualTimeline(visuals = [], {durationSeconds = 60, maxVisuals = 8, audioSegments = [], captions = [], minHoldSeconds = 3} = {}) {
  const usable = visuals.filter((visual) => typeof visual.imagePath === 'string' && visual.imagePath).slice(0, maxVisuals).map((visual, index) => {
    const startTurn = Math.max(0, Math.min(audioSegments.length - 1, Number(visual.startTurn ?? index * 2)));
    let anchor = audioSegments[startTurn]?.start ?? Number(visual.start ?? index * 9.5);
    if (visual.phrase) {
      const phrase = words(visual.phrase);
      const tokens = captions.flatMap(c=>c.tokens || [])
        .filter(t=>t.start>=anchor-0.001 && t.start < (audioSegments[startTurn]?.end ?? durationSeconds))
        .flatMap(token=>words(token.text).map(word=>({...token,word})));
      const match = tokens.findIndex((_, i)=>phrase.every((word,j)=>tokens[i+j]?.word===word));
      if (match >= 0) anchor = tokens[match].start;
    }
    return {
      kind: ['screenshot', 'logo'].includes(visual.kind) ? visual.kind : 'screenshot',
      title: String(visual.title ?? 'AI developer tool').trim() || 'AI developer tool',
      imagePath: visual.imagePath,
      sourceUrl: isSafeVisualUrl(visual.sourceUrl) ? visual.sourceUrl : null,
      start: anchor,
    };
  }).sort((a,b)=>a.start-b.start);
  const scheduled = [];
  for (const visual of usable) {
    const start = Math.max(visual.start, scheduled.length ? scheduled.at(-1).start + minHoldSeconds : 0);
    if (start >= durationSeconds) break;
    scheduled.push({...visual, start});
  }
  return scheduled.map((visual, index) => ({...visual, end: scheduled[index + 1]?.start ?? durationSeconds}));
}
