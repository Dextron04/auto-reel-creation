import test from 'node:test'; import assert from 'node:assert/strict'; import {rankConcepts,validateConcept} from './editorial.mjs';
const c=(category,score)=>({topic:`${category} topic`,tool_name:category,category,why_now:'now',developer_workflow:'workflow',claims:[{statement:'fact',source_url:`https://${category}.test`}],usefulness_score:score,workflow_score:score,evidence_score:score,momentum_score:score,hook_score:score});
test('validates citations',()=>assert.equal(validateConcept(c('x',1)).ok,true));
test('ranks distinct categories',()=>assert.equal(new Set(rankConcepts([c('a',90),c('a2',80),c('b',70)]).map(x=>x.category)).size,3));
