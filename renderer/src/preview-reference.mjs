// Reuses existing narration to exercise image discovery and rendering without another Qwen/TTS run.
import {discoverVisuals} from './asset-discovery.mjs';
import {renderReel} from './render.mjs';
import fs from 'node:fs/promises';
const texts = [
  'DeepSeek V4.1 Flash plus OpenAI Agents API on Vercel handles vision tasks without AI coding agents sandbox execution limits.',
  'Why load everything blindly for safe code?',
  'Vercel Sandbox executes safely on demand via Agent Skills packets now.',
  'Is that actually faster than text-only models really?',
  'Reducing waste via procedural packets prevents window saturation now.',
  'Okay, safer execution sounds worth the wait then.',
];
const job=await discoverVisuals({jobId:`reference-layout-${Date.now()}`,sourceVideo:'/media/source.mp4',durationInFrames:900,
  characterImages:{peter:'/media/peter.png',stewie:'/media/stewie.png'},
  dialogue:texts.map((text,i)=>({text,speaker:i%2?'stewie':'peter',audioPath:`/media/dialogue-${i}-${i%2?'stewie':'peter'}.wav`})),
  visualCues:[
    {turn_index:0,phrase:'DeepSeek',query:'DeepSeek logo',kind:'logo',visual_purpose:'identity',source_url:'https://github.com/deepseek-ai/DeepSeek-V3'},
    {turn_index:0,phrase:'OpenAI Agents',query:'OpenAI Agents SDK workflow',kind:'screenshot',visual_purpose:'mechanism',source_url:'https://github.com/openai/openai-agents-python'},
    {turn_index:2,phrase:'Vercel Sandbox',query:'Vercel Sandbox interface',kind:'screenshot',visual_purpose:'interface',source_url:'https://vercel.com/docs/vercel-sandbox'},
  ]});
await fs.writeFile('/output/reference-layout-job.json',JSON.stringify(job,null,2));
console.log(JSON.stringify({images:job.visuals.length,report:job.visualReport}));
console.log(await renderReel(job));
