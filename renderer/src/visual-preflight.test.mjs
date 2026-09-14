import test from 'node:test'; import assert from 'node:assert/strict'; import {buildStoryboard,scoreVisual,approveStoryboard} from './visual-preflight.mjs';
test('builds eight beats',()=>assert.equal(buildStoryboard({topic:'x',tool_name:'x'}).length,8));
test('requires eight approved visuals across six beats',()=>{const b=buildStoryboard({topic:'x',tool_name:'x'}); const xs=b.map((beat,i)=>scoreVisual({assetId:i},beat,{available:true,relevance:4,correctness:4,readability:3,interest:3,distinctness:3})); assert.equal(approveStoryboard(xs).beats,8);});
