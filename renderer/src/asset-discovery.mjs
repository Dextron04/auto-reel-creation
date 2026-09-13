import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MEDIA_ROOT} from './validation.mjs';

const exec = promisify(execFile);
export function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
}

// Resolve and pin the public address for every redirect. Never send local API credentials.
export async function getPublic(urlString, redirects = 0) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 4) throw new Error('INVALID_ASSET_URL');
  const addresses = await lookup(url.hostname, {all:true, family:4});
  if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new Error('NON_PUBLIC_ASSET');
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers:{'User-Agent':'ReelVisualCollector/1.0'}, lookup: (_host, options, cb) => cb(null, options.all ? addresses : addresses[0].address, 4)}, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); getPublic(new URL(res.headers.location, url).href, redirects+1).then(resolve,reject); return;
      }
      if (res.statusCode !== 200) {res.resume(); reject(new Error(`ASSET_HTTP_${res.statusCode}`)); return;}
      let size = 0; const chunks = [];
      res.on('data', chunk => {size += chunk.length; if (size > 8*1024*1024) req.destroy(new Error('ASSET_TOO_LARGE')); else chunks.push(chunk);});
      res.on('end', () => resolve({body:Buffer.concat(chunks), type:String(res.headers['content-type'] || ''), url:url.href}));
      res.on('error',reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('ASSET_TIMEOUT')), 12000);
    req.on('close', () => clearTimeout(timer)); req.on('error',reject);
  });
}

const decode = s => s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
export function pageImages(html, base, query) {
  const terms = String(query).toLowerCase().split(/\W+/).filter(s => s.length > 2);
  const candidates = [];
  for (const tag of html.match(/<(?:meta|img)\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(),decode(m[2])]));
    const social = /^(og:image|twitter:image)(:url)?$/.test(attrs.property || attrs.name || '');
    const src = social ? attrs.content : attrs.src || attrs['data-src'];
    if (!src) continue;
    try {
      const url = new URL(src,base).href;
      if (!url.startsWith('https:') || /favicon|tracking|pixel|spacer/i.test(url)) continue;
      const text = `${attrs.alt || ''} ${url}`.toLowerCase();
      const matches = terms.filter(term => text.includes(term)).length;
      if (!social && !matches) continue;
      candidates.push({url,sourceUrl:base,kind:/logo/i.test(text)?'logo':'screenshot',score:matches*5+(social?8:0),social,alt:attrs.alt || '',text});
    } catch {}
  }
  return [...new Map(candidates.sort((a,b)=>b.score-a.score).map(c=>[c.url,c])).values()];
}

export async function discoverVisuals(input) {
  const run = randomUUID(); const directory = path.join(MEDIA_ROOT,'visuals',run);
  await fs.mkdir(directory,{recursive:true});
  const visuals = []; const report = []; const used = new Set(); const pages = new Map();
  const sources = (input.research?.recommended_topic?.claims || []).map(c=>c.source_url).filter(Boolean);
  const cues = (input.visualCues || []).slice(0,8);
  for (const cue of cues) {
    const segment = input.dialogue?.[cue.turn_index];
    if (!segment || !String(segment.text).toLowerCase().includes(String(cue.phrase || '').toLowerCase()) || !cue.phrase) {report.push({cue,status:'invalid_phrase'}); continue;}
    const candidates = [];
    const urls = [...new Set([cue.source_url,...sources].filter(Boolean))].slice(0,3);
    for (const url of urls) {
      try {
        if (!pages.has(url)) pages.set(url, await getPublic(url));
        const response = pages.get(url);
        if (response.type.includes('text/html')) candidates.push(...pageImages(response.body.toString(),response.url,cue.query || cue.phrase));
      } catch (error) {report.push({sourceUrl:url,error:error.message});}
    }
    // Broad public image search supplements product/docs pages without requiring an API key.
    try {
      const search = new URL('https://commons.wikimedia.org/w/api.php');
      search.search = new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:String(cue.query || cue.phrase),gsrnamespace:'6',gsrlimit:'4',prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'1000'});
      const result = JSON.parse((await getPublic(search.href)).body);
      for (const page of Object.values(result.query?.pages || {})) {
        const info = page.imageinfo?.[0];
        if (info) candidates.push({url:info.thumburl || info.url,sourceUrl:info.descriptionurl,kind:'screenshot',score:1,attribution:info.extmetadata});
      }
    } catch (error) {report.push({query:cue.query,error:error.message});}
    const purpose = ['identity','interface','mechanism','outcome'].includes(cue.visual_purpose) ? cue.visual_purpose : 'interface';
    const purposeScore = candidate => {
      const description = `${candidate.alt || ''} ${candidate.text || ''}`.toLowerCase();
      if (purpose === 'identity') return (candidate.kind === 'logo' ? 12 : 0) + (candidate.social ? 4 : 0);
      if (purpose === 'interface') return /screenshot|dashboard|interface|editor|terminal|console|ui/.test(description) ? 12 : (candidate.social ? -3 : 0);
      if (purpose === 'mechanism') return /diagram|architecture|workflow|pipeline|flow|agent|sandbox/.test(description) ? 12 : (candidate.social ? -3 : 0);
      return /result|output|benchmark|performance|comparison|chart/.test(description) ? 12 : (candidate.social ? -3 : 0);
    };
    let chosen;
    for (const candidate of candidates.sort((a,b)=>(b.score+purposeScore(b))-(a.score+purposeScore(a))).filter(c=>!used.has(c.url)).slice(0,5)) {
      const temp = path.join(directory,`${randomUUID()}.download`);
      try {
        const response = await getPublic(candidate.url);
        if (!/^image\/(png|jpeg|webp|gif)/i.test(response.type)) continue;
        await fs.writeFile(temp,response.body);
        const {stdout} = await exec('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',temp],{timeout:10000});
        const dimensions = JSON.parse(stdout).streams[0];
        if (!dimensions || Math.min(dimensions.width,dimensions.height)<160 || dimensions.width*dimensions.height>24000000) continue;
        const filename = createHash('sha256').update(response.body).digest('hex').slice(0,20)+'.png';
        await exec('ffmpeg',['-v','error','-y','-i',temp,'-frames:v','1','-vf','scale=1200:1200:force_original_aspect_ratio=decrease',path.join(directory,filename)],{timeout:15000});
        chosen = {imagePath:`/media/visuals/${run}/${filename}`,title:cue.query || cue.phrase,kind:cue.kind === 'logo'?'logo':candidate.kind,visualPurpose:purpose,startTurn:Number(cue.turn_index),phrase:cue.phrase,sourceUrl:candidate.sourceUrl,assetUrl:candidate.url,attribution:candidate.attribution || null};
        used.add(candidate.url); break;
      } catch (error) {report.push({url:candidate.url,error:error.message});}
      finally {await fs.unlink(temp).catch(()=>{});}
    }
    if (chosen) visuals.push(chosen);
    report.push({cue,status:chosen?'downloaded':'no_image'});
  }
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({visuals,report},null,2));
  return {...input,visuals,visualReport:report};
}
