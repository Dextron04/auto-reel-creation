import {discoverTrends} from '../renderer/src/trend-discovery.mjs';
import {rankConcepts} from '../renderer/src/editorial.mjs';
import {buildStoryboard,scoreVisual,approveStoryboard} from '../renderer/src/visual-preflight.mjs';
const signals = discoverTrends({sources:[{publisher:'fixture-a',items:Array.from({length:6},(_,i)=>({title:`Tool ${i}`,url:`https://fixture.test/${i}`,category:['agents','testing','observability'][i%3],developer_relevance:80,authority_score:70}))}],limits:{minSignals:5,maxPerPublisher:6}}).signals;
const concepts = rankConcepts(signals.slice(0,3).map((s,i)=>({topic:s.title,tool_name:s.title,category:s.category,why_now:'fixture',developer_workflow:'fixture workflow',claims:[{statement:'fixture claim',source_url:s.source_url},{statement:'second claim',source_url:`${s.source_url}/docs`}],usefulness_score:80-i,workflow_score:80,evidence_score:80,momentum_score:70,hook_score:70})));
const storyboard = buildStoryboard(concepts[0]); const approved = approveStoryboard(storyboard.map((b,i)=>scoreVisual({assetId:`a${i}`},b,{available:true,relevance:4,correctness:4,readability:4,interest:3,distinctness:3})));
console.log(JSON.stringify({dryRun:true,signals:signals.length,concepts:concepts.length,approvedVisuals:approved.approved.length},null,2));
