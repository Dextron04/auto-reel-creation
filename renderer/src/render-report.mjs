export function createRenderReport(request, outputLocation) {
  return {
    outputLocation,
    durationInFrames: request.durationInFrames,
    durationSeconds: request.durationInFrames / 30,
    playbackRate: request.playbackRate ?? 1,
    audioEndSeconds: request.audioSegments?.at(-1)?.end ?? 0,
    captionCount: request.captions?.length ?? 0,
    characterSegmentCount: request.characterSegments?.length ?? 0,
    visualCount: request.visuals?.length ?? 0,
    visualPaths: (request.visuals ?? []).map(visual => visual.imagePath),
    visualCoverageSeconds: (request.visuals ?? []).reduce((sum, visual) => sum + (visual.end - visual.start), 0),
    sequenceReview: request.sequenceReview ?? null,
  };
}
