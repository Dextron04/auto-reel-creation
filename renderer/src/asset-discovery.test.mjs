import test from 'node:test';
import assert from 'node:assert/strict';
import {pageImages,publicAddress,readmeImages,assetKey,keyOf,purposeScore,isUsableVisualCue,SCREENSHOT_SLICES} from './asset-discovery.mjs';
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
  assert.deepEqual(parseJudgement('Sure: {"best": 2, "reason": "shows the dashboard"}',3),{index:1,reason:'shows the dashboard'});
  assert.equal(parseJudgement('{"best": 0, "reason": "none fit"}',3).index,null);
  assert.equal(parseJudgement('{"best": 7, "reason": "?"}',3).index,null);
  assert.equal(parseJudgement('not json',3).index,null);
});
test('judge prompt carries the spoken line, phrase and purpose',()=>{
  const prompt=judgePrompt({tool:'Agents API',topic:'managed agent loops',turnText:'It handles retries for you.',phrase:'handles retries',purpose:'mechanism',query:'retry diagram'});
  for(const piece of ['Agents API','It handles retries for you.','handles retries','diagram or code','different product than Agents API','"best"']) assert.match(prompt,new RegExp(piece.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
import {parseBraveResults} from './asset-discovery.mjs';
test('Brave image results map onto the same candidate shape',()=>{
  const out=parseBraveResults({results:[{url:'https://page.example/a',title:'Arch diagram',properties:{url:'https://img.example/a.png',width:1200,height:700}}]},'arch');
  assert.deepEqual(out.map(r=>[r.url,r.sourceUrl,r.title]),[['https://img.example/a.png','https://page.example/a','Arch diagram']]);
});
