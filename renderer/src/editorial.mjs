const clamp = n => Math.max(0, Math.min(100, Number(n) || 0));
export function validateConcept(concept = {}) {
  const reasons = [];
  if (!concept.topic || !concept.tool_name || !concept.category) reasons.push('MISSING_TOPIC_IDENTITY');
  if (!concept.why_now || !concept.developer_workflow) reasons.push('MISSING_WORKFLOW_CONTEXT');
  if (!Array.isArray(concept.claims) || concept.claims.length < 1 || concept.claims.some(c => !c.statement || !/^https?:\/\//.test(c.source_url || ''))) reasons.push('UNSUPPORTED_CLAIM');
  if (new Set((concept.claims || []).map(c => c.source_url)).size < Math.min(2, concept.claims?.length || 0)) reasons.push('LOW_SOURCE_DIVERSITY');
  return {ok: reasons.length === 0, reasons};
}
export function scoreConcept(concept = {}) {
  const components = {
    usefulness: clamp(concept.usefulness_score ?? concept.developer_usefulness ?? 0),
    workflow: clamp(concept.workflow_score ?? concept.teachability ?? 0),
    evidence: clamp(concept.evidence_score ?? 0),
    momentum: clamp(concept.momentum_score ?? concept.audience_momentum ?? 0),
    hook: clamp(concept.hook_score ?? concept.visual_potential ?? 0),
  };
  const score = components.usefulness * .30 + components.workflow * .20 + components.evidence * .20 + components.momentum * .20 + components.hook * .10;
  return {...concept, component_scores: components, editorial_score: Number(score.toFixed(2))};
}
export function rankConcepts(concepts = []) {
  const valid = concepts.map(scoreConcept).filter(c => validateConcept(c).ok).sort((a,b) => b.editorial_score - a.editorial_score);
  const picked = []; const categories = new Set();
  for (const concept of valid) { if (picked.length >= 3) break; if (categories.has(concept.category) && valid.some(c => c.category !== concept.category && !categories.has(c.category))) continue; picked.push(concept); categories.add(concept.category); }
  return picked;
}
