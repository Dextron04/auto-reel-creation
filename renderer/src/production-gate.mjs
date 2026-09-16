import {validateDialogue} from './sequence-review.mjs';
import {validateVisualSelection} from './asset-discovery.mjs';

// Anchor gate is structural only: a valid turn index and a non-empty phrase. Whether the phrase
// literally appears in that turn's text is not enforced here — asset-discovery's resolveCueTurn
// already retargets a cue to wherever its phrase actually anchors when possible, and when it
// can't (the phrase paraphrases the idea, or was pulled from source material rather than the
// dialogue verbatim), buildVisualTimeline falls back to the turn's start rather than failing.
// Every content-matching variant tried here (raw substring, ellipsis-tolerant, suffix-tolerant,
// cross-turn search) kept being defeated by a new flavor of ordinary LLM paraphrase drift; the
// render pipeline was already built to not need this enforced upstream.
export function validateProductionPackage({dialogue = [], visuals = [], storyboard = [], minimumImages} = {}) {
  const errors = [];
  const dialogueResult = validateDialogue(dialogue, storyboard);
  errors.push(...dialogueResult.errors);
  // requiredTurns tracks whatever length dialogue actually is (6 for the tool-trend show, fewer
  // for a shorter reel) rather than a value hardcoded to the original 6-turn format.
  try { validateVisualSelection(visuals, {requiredTurns: dialogue.length || 6, minimumImages: Number(minimumImages) || 8}); }
  catch (error) { errors.push(error.message); }
  for (const visual of visuals) {
    const turn = visual.startTurn;
    const phrase = String(visual.phrase ?? '').trim();
    if (!Number.isInteger(turn) || turn < 0 || turn >= dialogue.length || !phrase) errors.push(`VISUAL_ANCHOR_MISSING:${Number.isInteger(turn) ? turn : 'INVALID'}`);
  }
  return {ok: errors.length === 0, errors: [...new Set(errors)]};
}
