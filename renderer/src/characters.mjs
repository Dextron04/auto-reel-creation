export function buildCharacterSegments(audioSegments = [], characterImages = {}) {
  return audioSegments.flatMap((segment) => {
    const imagePath = characterImages[segment.speaker];
    if (!imagePath || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) return [];
    return [{speaker: segment.speaker, imagePath, start: segment.start, end: segment.end}];
  });
}
