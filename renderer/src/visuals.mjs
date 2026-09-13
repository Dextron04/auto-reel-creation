export function isSafeVisualUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildVisualTimeline(visuals = [], {durationSeconds = 29.5, maxVisuals = 8, audioSegments = [], captions = []} = {}) {
  const usable = visuals.filter((visual) => typeof visual.imagePath === 'string' && visual.imagePath).slice(0, maxVisuals).map((visual, index) => {
    const startTurn = Math.max(0, Math.min(audioSegments.length - 1, Number(visual.startTurn ?? index * 2)));
    const endTurn = Math.max(startTurn, Math.min(audioSegments.length - 1, Number(visual.endTurn ?? startTurn)));
    let anchor = audioSegments[startTurn]?.start ?? Number(visual.start ?? index * 9.5);
    if (visual.phrase) {
      const clean = text => text.toLowerCase().replace(/[^a-z0-9]/g,'');
      const phrase = visual.phrase.split(/\s+/).map(clean);
      const tokens = captions.flatMap(c=>c.tokens || []).filter(t=>t.start>=anchor-0.001 && t.start < (audioSegments[startTurn]?.end ?? durationSeconds));
      const match = tokens.findIndex((_, i)=>phrase.every((word,j)=>clean(tokens[i+j]?.text || '')===word));
      if (match < 0) return null;
      anchor = tokens[match].start;
    }
    return {
      kind: ['screenshot', 'logo'].includes(visual.kind) ? visual.kind : 'screenshot',
      title: String(visual.title ?? 'AI developer tool').trim() || 'AI developer tool',
      imagePath: visual.imagePath,
      sourceUrl: isSafeVisualUrl(visual.sourceUrl) ? visual.sourceUrl : null,
      start: anchor,
      end: visual.phrase ? Math.min(durationSeconds,anchor+4.5) : audioSegments[endTurn]?.end ?? Number(visual.end ?? Math.min(durationSeconds, (index + 1) * 9.5)),
    };
  });
  return usable.filter((visual) => visual && visual.end > visual.start).sort((a,b)=>a.start-b.start).map((visual,index,list) => ({
    ...visual,
    start: Math.min(visual.start, durationSeconds),
    end: Math.min(visual.end, durationSeconds, list[index+1]?.start ?? durationSeconds),
  }));
}
