import {validateDialogue} from './sequence-review.mjs';
import {validateVisualSelection} from './asset-discovery.mjs';
import {phraseAnchorsTurn} from './visuals.mjs';

export function validateProductionPackage({dialogue = [], visuals = [], storyboard = []} = {}) {
  const errors = [];
  const dialogueResult = validateDialogue(dialogue, storyboard);
  errors.push(...dialogueResult.errors);
  try { validateVisualSelection(visuals); }
  catch (error) { errors.push(error.message); }
  for (const visual of visuals) {
    const turn = visual.startTurn;
    const phrase = String(visual.phrase ?? '').trim();
    if (!Number.isInteger(turn) || turn < 0 || turn >= dialogue.length || !phrase || !phraseAnchorsTurn(dialogue[turn]?.text, phrase)) errors.push(`VISUAL_ANCHOR_MISSING:${Number.isInteger(turn) ? turn : 'INVALID'}`);
  }
  return {ok: errors.length === 0, errors: [...new Set(errors)]};
}
