import test from 'node:test';
import assert from 'node:assert/strict';
import {pageImages,publicAddress,readmeImages,assetKey,keyOf,purposeScore,isUsableVisualCue,SCREENSHOT_SLICES,validateVisualSelection,visualSearchQuery,candidateMatchesCueSource,sourcePageFallbackAllowed,candidateIsUsableStock,normalizeVisualCues} from './asset-discovery.mjs';
import {buildVisualTimeline} from './visuals.mjs';
test('extracts relevant page images and resolves relative sources',()=>{
  const result=pageImages('<meta property="og:image" content="/preview.png"><img src="/workflow.png" alt="Agent workflow"><img src="/ad.png" alt="Buy shoes">','https://example.com/docs','Agent workflow');
  assert.deepEqual(result.map(r=>r.url),['https://example.com/workflow.png','https://example.com/preview.png']);
});
test('extracts an official site icon as a logo fallback',()=>{
  const result=pageImages('<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/touch.png">','https://example.com/docs','Unknown tool');
  assert.deepEqual(result.map(r=>({url:r.url,kind:r.kind})),[
    {url:'https://example.com/touch.png',kind:'logo'},
    {url:'https://example.com/icon.png',kind:'logo'},
  ]);
});
test('page chrome such as avatars and badges is never a visual',()=>{
  const result=pageImages('<img src="/avatar/agent.png" alt="agent"><img src="/badges/agent.svg" alt="agent"><img src="/agent-ui.png" alt="agent ui">','https://example.com/','agent');
  assert.deepEqual(result.map(r=>r.url),['https://example.com/agent-ui.png']);
});
test('site icons score for identity and page screenshots score for interface',()=>{
  assert.ok(purposeScore({kind:'logo',icon:true,text:'https://dev.to/icon.png'},'identity')>0);
  assert.ok(purposeScore({kind:'screenshot',text:'page screenshot interface example.com'},'interface')>0);
});
test('each screenshot slice is a distinct asset while CDN variants collapse',()=>{
  assert.notEqual(keyOf({url:'https://example.com/',assetId:'https://example.com/#view0'}),keyOf({url:'https://example.com/',assetId:'https://example.com/#view1'}));
  assert.equal(keyOf({url:'https://cdn.example/a.png?w=1'}),keyOf({url:'https://cdn.example/a.png?w=2'}));
});
test('rejects internal network addresses',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','::1']) assert.equal(publicAddress(address),false);
  assert.equal(publicAddress('8.8.8.8'),true);
});
test('the same artwork behind CDN size variants is recognised as one asset',()=>{
  const a='https://media2.dev.to/dynamic/image/width=180,height=,fit=scale-down/https%3A%2F%2Fuploads.s3.amazonaws.com%2Farticles%2Fabc.png';
  const b='https://media2.dev.to/dynamic/image/width=32,height=,fit=scale-down/https%3A%2F%2Fuploads.s3.amazonaws.com%2Farticles%2Fabc.png';
  assert.equal(assetKey(a),assetKey(b));
  assert.equal(assetKey('https://cdn.example/card.jpg?w=1200'),assetKey('https://cdn.example/card.jpg?w=600'));
});
test('README screenshots and diagrams become candidates but badges do not',()=>{
  const md='![CI](https://img.shields.io/badge/ci-passing.svg)\n![Agent dashboard](docs/dashboard.png)\n<img src="https://cdn.example/arch.png" alt="Architecture diagram">';
  const result=readmeImages(md,'https://github.com/acme/agent-kit','agent dashboard');
  assert.deepEqual(result.map(r=>r.url),['https://raw.githubusercontent.com/acme/agent-kit/HEAD/docs/dashboard.png','https://cdn.example/arch.png']);
  assert.ok(purposeScore(result[1],'mechanism')>0);
});
test('an inexact Claude phrase remains usable when its dialogue turn exists',()=>{
  const dialogue=[{text:'Why does vendor lock-in matter if the agent works?'}];
  assert.equal(isUsableVisualCue({turn_index:0,phrase:"vendor's SDK"},dialogue),true);
  assert.equal(isUsableVisualCue({turn_index:2,phrase:'missing turn'},dialogue),false);
});
test('page screenshots are sliced into distinct views',()=>{
  assert.equal(new Set(SCREENSHOT_SLICES).size,3);
});
test('a phrase cue begins at its caption token and ends where the next visual starts',()=>{
  const result=buildVisualTimeline([{imagePath:'/media/a.png',startTurn:0,phrase:'DeepSeek'},{imagePath:'/media/b.png',startTurn:0,phrase:'coding'}],{audioSegments:[{start:0,end:8}],captions:[{tokens:[{text:'Meet',start:0,end:1},{text:'DeepSeek',start:1,end:2},{text:'coding',start:3,end:4}]}]});
  assert.equal(result[0].start,1);assert.equal(result[0].end,4);assert.equal(result[1].start,4);
});
import {parseSearchResults,parseJudgement,judgePrompt} from './asset-discovery.mjs';
test('web image search results become ranked candidates and tiny images are dropped',()=>{
  const json={results:[{image:'https://cdn.example/diagram.png',url:'https://blog.example/post',title:'Agent loop diagram',width:1600,height:900},{image:'https://cdn.example/tiny.png',url:'https://x',title:'tiny',width:120,height:80},{image:'http://insecure.example/a.png',url:'https://x',title:'http',width:1000,height:800}]};
  const result=parseSearchResults(json,'agent loop');
  assert.deepEqual(result.map(r=>[r.url,r.sourceUrl,r.score,r.search]),[['https://cdn.example/diagram.png','https://blog.example/post',9,true]]);
});
test('judge verdicts are parsed strictly and out-of-range picks mean no image',()=>{
  assert.deepEqual(parseJudgement('Sure: {"best": 2, "reason": "shows the dashboard"}',3),{index:1,reason:'shows the dashboard',suggestedQuery:null});
  assert.equal(parseJudgement('{"best": 0, "reason": "none fit"}',3).index,null);
  assert.equal(parseJudgement('{"best": 7, "reason": "?"}',3).index,null);
  assert.equal(parseJudgement('not json',3).index,null);
});
test('a rejection carries the judge\'s suggested follow-up search query',()=>{
  const rejected = parseJudgement('{"best": 0, "reason": "none show the metric", "suggested_query": "DeepSeek V4.1 Flash pricing dashboard screenshot"}',4);
  assert.equal(rejected.index,null);
  assert.equal(rejected.suggestedQuery,'DeepSeek V4.1 Flash pricing dashboard screenshot');
  assert.equal(parseJudgement('{"best": 2, "reason": "shows it"}',3).suggestedQuery,null);
});
test('judge prompt carries the spoken line, phrase and purpose',()=>{
  const prompt=judgePrompt({tool:'Agents API',topic:'managed agent loops',turnText:'It handles retries for you.',phrase:'handles retries',purpose:'mechanism',query:'retry diagram'});
  for(const piece of ['Agents API','It handles retries for you.','handles retries','diagram or code','different product than Agents API','"best"']) assert.match(prompt,new RegExp(piece.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
test('stock cues search for the requested scene instead of the product interface',()=>{
  assert.equal(visualSearchQuery('Agentwire',{kind:'stock'},'developer confused at laptop'),'developer confused at laptop');
  assert.equal(visualSearchQuery('Agentwire',{kind:'screenshot'},'filter controls'),'Agentwire filter controls');
  assert.equal(sourcePageFallbackAllowed({kind:'stock'}),false);
  assert.equal(sourcePageFallbackAllowed({kind:'screenshot'}),true);
});
test('stock cue judging allows people while rejecting product dashboards',()=>{
  const prompt=judgePrompt({tool:'Agentwire',topic:'tool discovery',turnText:'Why another index?',phrase:'Why another index',purpose:'reaction',kind:'stock',query:'developer confused'});
  assert.match(prompt,/stock photo or editorial illustration/i);
  assert.match(prompt,/people are acceptable/i);
  assert.match(prompt,/reject product dashboards/i);
  assert.match(prompt,/visible watermarks/i);
});
test('premium stock previews are rejected before vision judging',()=>{
  assert.equal(candidateIsUsableStock({url:'https://plus.unsplash.com/premium_photo.jpg',sourceUrl:'https://unsplash.com/photos/example'}),false);
  assert.equal(candidateIsUsableStock({url:'https://media.gettyimages.com/id/123/photo.jpg',sourceUrl:'https://gettyimages.com/detail/123'}),false);
  assert.equal(candidateIsUsableStock({url:'https://images.pexels.com/photos/123/photo.jpeg',sourceUrl:'https://pexels.com/photo/example'}),true);
});
test('visual discovery caps stock cues and turns overflow into cited product details',()=>{
  const cues=Array.from({length:4},(_,index)=>({turn_index:index,phrase:`turn ${index}`,query:`query ${index}`,kind:'stock',visual_purpose:index<2?'reaction':'context',source_url:'https://stock.example'}));
  const result=normalizeVisualCues(cues,{tool:'Agentwire',citedSource:'https://dev.to/agentwire'});
  assert.equal(result.filter(cue=>cue.kind==='stock').length,2);
  assert.deepEqual(result.slice(2).map(cue=>cue.source_url),['https://dev.to/agentwire','https://dev.to/agentwire']);
  assert.ok(result.slice(2).every(cue=>/Agentwire.*interface detail/i.test(cue.query)));
});
test('product screenshots must come from the cited source page',()=>{
  const cue={kind:'screenshot',source_url:'https://dev.to/compoundlabs/agentwire-review'};
  const sources=['https://dev.to/compoundlabs/agentwire-review'];
  assert.equal(candidateMatchesCueSource({sourceUrl:'https://dev.to/compoundlabs/agentwire-review'},cue,sources),true);
  assert.equal(candidateMatchesCueSource({sourceUrl:'https://agentsview.io/usage'},cue,sources),false);
  assert.equal(candidateMatchesCueSource({sourceUrl:'https://learn.microsoft.com/model-benchmarks'},cue,sources),false);
});
import {parseBraveResults,parseSearxngResults} from './asset-discovery.mjs';
test('Brave image results map onto the same candidate shape',()=>{
  const out=parseBraveResults({results:[{url:'https://page.example/a',title:'Arch diagram',properties:{url:'https://img.example/a.png',width:1200,height:700}}]},'arch');
  assert.deepEqual(out.map(r=>[r.url,r.sourceUrl,r.title]),[['https://img.example/a.png','https://page.example/a','Arch diagram']]);
});
test('SearXNG results drop icon-library SVGs and tiny images, keep real screenshots',()=>{
  const out=parseSearxngResults({results:[
    {img_src:'https://cdn.jsdelivr.net/npm/lucide-static/icons/ad.svg',url:'https://icons.example',title:'ad icon',img_format:'SVG',resolution:''},
    {img_src:'https://cdn.example/tiny.png',url:'https://x',title:'tiny',img_format:'',resolution:'120x80'},
    {img_src:'https://code.visualstudio.com/assets/docs/agents/chat-debug-view/agent-logs.png',url:'https://code.visualstudio.com/docs/agents/chat-debug-view',title:'Debug chat interactions',img_format:'png',resolution:'1808×1130'},
  ]},'coding agent debugging');
  assert.deepEqual(out.map(r=>[r.url,r.sourceUrl,r.title]),[['https://code.visualstudio.com/assets/docs/agents/chat-debug-view/agent-logs.png','https://code.visualstudio.com/docs/agents/chat-debug-view','Debug chat interactions']]);
});
test('visual preflight blocks fewer than six distinct approved images',()=>{
  const duplicated = Array.from({length:6},(_,index)=>({assetUrl:index<2?'https://cdn.example/same.png':`https://cdn.example/${index}.png`,startTurn:index%6,judgement:'approved'}));
  assert.throws(()=>validateVisualSelection(duplicated),/VISUAL_PREFLIGHT_FAILED:5_DISTINCT_IMAGES/);
});
test('screenshot slices of the same page each count as a distinct approved image',()=>{
  // Reproduces a real production failure: three genuinely different crops of one page
  // (hero/middle/lower, assetId `<url>#view0/1/2`) were miscounted as one duplicate
  // because the old check ran assetUrl through assetKey(), which strips URL fragments.
  const slices = ['#view0','#view1','#view2'].map((view,index)=>({assetUrl:`https://example.com/page${view}`,startTurn:index,judgement:'approved'}));
  const turns = [3,4,5,0,1];
  const others = Array.from({length:5},(_,index)=>({assetUrl:`https://cdn.example/${index}.png`,startTurn:turns[index],judgement:'approved'}));
  const result = validateVisualSelection([...slices,...others]);
  assert.equal(result.distinctImages,8);
});
test('visual preflight accepts eight distinct vision-approved images covering every turn',()=>{
  const visuals = Array.from({length:8},(_,index)=>({assetUrl:`https://cdn.example/${index}.png`,startTurn:index%6,judgement:'matches dialogue'}));
  assert.equal(validateVisualSelection(visuals).distinctImages,8);
});
// A live run lost an entire render over exactly this: an abstract, screenshot-poor topic left one
// turn (out of six) with zero approved images, and the old hard gate failed the whole video for
// it. buildVisualTimeline() (visuals.mjs) already schedules only the visuals that exist and lets
// the previous one's on-screen time extend to cover any gap -- the same behavior already
// documented for a single rejected cue -- so a fully-uncovered turn renders correctly without this
// gate; requiring every turn to have its own anchor was strictly more demanding than the render
// pipeline itself needs.
test('visual preflight accepts a fully uncovered turn -- the render timeline already covers a gap by holding the previous image',()=>{
  const indexes = [0,0,1,2,3,4];
  const visuals = Array.from({length:6},(_,index)=>({assetUrl:`https://cdn.example/${index}.png`,startTurn:indexes[index],judgement:'matches dialogue'}));
  const result = validateVisualSelection(visuals);
  assert.equal(result.distinctImages,6);
  assert.equal(result.coveredTurns,5, 'turn 5 has zero images and that is fine -- diagnostic only, not a failure');
});
test('visual preflight does not coerce missing or empty turn indexes to turn zero',()=>{
  for (const invalid of [null, '', undefined, '0']) {
    const visuals = Array.from({length:8},(_,index)=>({assetUrl:`https://cdn.example/${index}.png`,startTurn:index%6,judgement:'matches dialogue'}));
    visuals[0].startTurn = invalid;
    assert.throws(()=>validateVisualSelection(visuals),/VISUAL_PREFLIGHT_FAILED:INVALID_TURN_INDEX/);
  }
});
