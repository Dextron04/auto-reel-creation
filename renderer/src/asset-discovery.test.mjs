import test from 'node:test';
import assert from 'node:assert/strict';
import {pageImages,publicAddress} from './asset-discovery.mjs';
import {buildVisualTimeline} from './visuals.mjs';
test('extracts relevant page images and resolves relative sources',()=>{
  const result=pageImages('<meta property="og:image" content="/preview.png"><img src="/workflow.png" alt="Agent workflow"><img src="/ad.png" alt="Buy shoes">','https://example.com/docs','Agent workflow');
  assert.deepEqual(result.map(r=>r.url),['https://example.com/workflow.png','https://example.com/preview.png']);
});
test('rejects internal network addresses',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','::1']) assert.equal(publicAddress(address),false);
  assert.equal(publicAddress('8.8.8.8'),true);
});
test('a phrase cue begins at its caption token and ends before the next visual',()=>{
  const result=buildVisualTimeline([{imagePath:'/media/a.png',startTurn:0,phrase:'DeepSeek'},{imagePath:'/media/b.png',startTurn:0,phrase:'coding'}],{audioSegments:[{start:0,end:8}],captions:[{tokens:[{text:'Meet',start:0,end:1},{text:'DeepSeek',start:1,end:2},{text:'coding',start:3,end:4}]}]});
  assert.equal(result[0].start,1);assert.equal(result[0].end,3);assert.equal(result[1].start,3);
});
