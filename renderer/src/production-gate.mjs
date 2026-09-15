import {validateDialogue} from './sequence-review.mjs';
import {validateVisualSelection} from './asset-discovery.mjs';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT ?? '/media');

export function parseSequenceReview(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match?.[0] ?? '');
    const scores = Object.fromEntries(['relevance', 'coverage', 'variety', 'readability', 'pacing'].map(key => [key, Math.max(0, Math.min(5, Number(parsed[key]) || 0))]));
    return {passed: Object.values(scores).every(value => value >= 3), scores, reason: String(parsed.reason ?? '').trim()};
  } catch {
    return {passed: false, scores: {relevance: 0, coverage: 0, variety: 0, readability: 0, pacing: 0}, reason: 'SEQUENCE_REVIEW_INVALID_JSON'};
  }
}

export async function reviewSequenceWithVision({dialogue = [], visuals = [], model = process.env.ANTHROPIC_SEQUENCE_REVIEW_MODEL ?? process.env.ANTHROPIC_VISUAL_JUDGE_MODEL ?? 'claude-haiku-4-5'} = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('SEQUENCE_REVIEW_UNAVAILABLE');
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const selected = visuals.slice(0, 12);
  const content = [{type: 'text', text: `Review this proposed vertical reel sequence. The dialogue is:\n${dialogue.map(turn => `${turn.speaker}: ${turn.text}`).join('\n')}\n\nScore the supplied visual sequence from 0 to 5 for relevance to the dialogue, coverage of spoken turns, visual variety, mobile readability, and pacing. Return ONLY JSON with numeric keys relevance, coverage, variety, readability, pacing and a short reason. Do not infer quality from filenames alone.`}];
  for (const visual of selected) {
    const raw = String(visual.imagePath ?? '');
    const absolute = path.resolve(raw.startsWith('/media/') ? raw : path.join(MEDIA_ROOT, raw));
    if (absolute !== MEDIA_ROOT && !absolute.startsWith(`${MEDIA_ROOT}${path.sep}`)) throw new Error('SEQUENCE_REVIEW_INVALID_ASSET');
    const data = await fs.readFile(absolute);
    const extension = path.extname(absolute).toLowerCase();
    const mediaType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png';
    content.push({type: 'text', text: `Visual ${selected.indexOf(visual) + 1}: ${visual.title ?? visual.visualPurpose ?? 'asset'}`});
    content.push({type: 'image', source: {type: 'base64', media_type: mediaType, data: data.toString('base64')}});
  }
  const response = await client.messages.create({model, max_tokens: 500, messages: [{role: 'user', content}]});
  return parseSequenceReview(response.content?.find(item => item.type === 'text')?.text ?? '');
}

export function validateProductionPackage({dialogue = [], visuals = [], storyboard = [], sequenceReview} = {}) {
  const errors = [];
  const dialogueResult = validateDialogue(dialogue, storyboard);
  errors.push(...dialogueResult.errors);
  try { validateVisualSelection(visuals); }
  catch (error) { errors.push(error.message); }
  if (sequenceReview && sequenceReview.passed !== true) errors.push('SEQUENCE_REVIEW_FAILED');
  return {ok: errors.length === 0, errors: [...new Set(errors)]};
}
