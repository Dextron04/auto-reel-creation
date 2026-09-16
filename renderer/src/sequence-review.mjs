export function validateDialogue(dialogue = [], storyboard = []) {
  const errors = [];
  if (!dialogue.length || dialogue.length % 2 !== 0) errors.push('DIALOGUE_REQUIRES_ALTERNATING_TURNS');
  const expected = dialogue.map((_, i) => (i % 2 === 0 ? 'peter' : 'stewie'));
  dialogue.forEach((turn, i) => { if (String(turn.speaker).toLowerCase() !== expected[i]) errors.push(`DIALOGUE_SPEAKER_ORDER:${i}`); });
  for (const cue of dialogue.flatMap(turn => turn.visuals || [])) if (!dialogue[cue.turn_index]?.text?.includes(cue.phrase)) errors.push(`VISUAL_ANCHOR_MISSING:${cue.turn_index}`);
  if (storyboard.length && dialogue.flatMap(t => t.visuals || []).length < storyboard.length) errors.push('VISUAL_CUE_COVERAGE');
  return {ok:errors.length === 0, errors};
}
export function reviewSequence({dialogue = [], visuals = [], scores = {}} = {}) {
  const values = {relevance:Number(scores.relevance ?? 0), coverage:Number(scores.coverage ?? 0), variety:Number(scores.variety ?? 0), readability:Number(scores.readability ?? 0), pacing:Number(scores.pacing ?? 0)};
  const passed = Object.values(values).every(v => v >= 3) && visuals.length >= 8 && validateDialogue(dialogue).ok;
  return {passed, scores:values, error:passed ? null : 'SEQUENCE_REVIEW_FAILED'};
}
