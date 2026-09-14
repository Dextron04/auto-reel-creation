export const MIN_APPROVED_VISUALS = 8;
export function buildStoryboard(concept = {}) {
  const purposes = ['identity','interface','mechanism','evidence','outcome','reaction','context','interface'];
  return purposes.map((purpose, index) => ({beat_id:`b${index + 1}`, index, fact: concept.claims?.[index % Math.max(1, concept.claims.length)]?.statement || concept.developer_workflow || concept.topic, visual_purpose:purpose, queries:[`${concept.tool_name} ${purpose} screenshot`, `${concept.topic} ${purpose} diagram`, `${concept.tool_name} developer ${purpose}`], stock_allowed:['context','reaction'].includes(purpose)}));
}
export function scoreVisual(candidate = {}, beat = {}, vision = {}) {
  const scores = {relevance:Number(vision.relevance ?? candidate.relevance ?? 0), correctness:Number(vision.correctness ?? candidate.correctness ?? 0), readability:Number(vision.readability ?? candidate.readability ?? 0), interest:Number(vision.interest ?? candidate.interest ?? 0), distinctness:Number(vision.distinctness ?? candidate.distinctness ?? 0)};
  const approved = vision.available !== false && scores.relevance >= 3 && scores.correctness >= 3 && Object.values(scores).reduce((a,b) => a + b, 0) >= 15;
  return {...candidate, beat_id:beat.beat_id, scores, approved, rejection_reason:approved ? null : (vision.available === false ? 'VISION_JUDGE_UNAVAILABLE' : 'VISUAL_SCORE_TOO_LOW')};
}
export function approveStoryboard(storyboard = []) {
  const approved = storyboard.filter(item => item.approved); const beats = new Set(approved.map(item => item.beat_id));
  if (approved.length < MIN_APPROVED_VISUALS || beats.size < 6) throw new Error('VISUAL_PREFLIGHT_FAILED');
  return {approved, beats:beats.size, visual_changes_every_seconds:3.5};
}
