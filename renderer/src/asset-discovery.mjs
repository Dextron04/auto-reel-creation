import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import {MEDIA_ROOT, OUTPUT_ROOT} from './validation.mjs';
import {pruneGeneratedMedia} from './retention.mjs';

export {pruneGeneratedMedia, withActiveOutput} from './retention.mjs';

const exec = promisify(execFile);
const CHROMIUM = process.env.REMOTION_BROWSER_EXECUTABLE ?? '/usr/bin/chromium';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
}

async function publicAddresses(hostname) {
  const addresses = await lookup(hostname, {all:true, family:4});
  if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new Error('NON_PUBLIC_ASSET');
  return addresses;
}

// Resolve and pin the public address for every redirect. Never send local API credentials.
export async function getPublic(urlString, redirects = 0, headers = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 4) throw new Error('INVALID_ASSET_URL');
  const addresses = await publicAddresses(url.hostname);
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers:{'User-Agent':'ReelVisualCollector/1.0', ...headers}, lookup: (_host, options, cb) => cb(null, options.all ? addresses : addresses[0].address, 4)}, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); getPublic(new URL(res.headers.location, url).href, redirects+1, headers).then(resolve,reject); return;
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

// Chromium resolves DNS itself, so route it through a CONNECT proxy that applies the same public-address rule.
async function withGuardedProxy(fn) {
  const server = http.createServer((_req, res) => {res.writeHead(403); res.end();});
  server.on('connect', async (req, socket, head) => {
    const [host, port = '443'] = req.url.split(':');
    try {
      if (port !== '443') throw new Error('port');
      const [{address}] = await publicAddresses(host);
      const upstream = net.connect(443, address, () => {socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);});
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    } catch {socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {return await fn(server.address().port);} finally {server.close();}
}

// Full-page screenshot sliced into distinct views (hero, middle, lower) so one page yields several relevant visuals.
export const SCREENSHOT_SLICES = ['crop=iw:ih*0.42:0:0', 'crop=iw:ih*0.42:0:ih*0.29', 'crop=iw:ih*0.42:0:ih*0.58'];
export async function screenshotPage(urlString, directory) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:') throw new Error('INVALID_ASSET_URL');
  await publicAddresses(url.hostname);
  const shot = path.join(directory, `${randomUUID()}.shot.png`);
  await withGuardedProxy(port => exec(CHROMIUM, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars','--window-size=1440,2400','--virtual-time-budget=6000',`--proxy-server=http://127.0.0.1:${port}`,`--screenshot=${shot}`,url.href], {timeout:45000}));
  const slices = [];
  for (const [index, crop] of SCREENSHOT_SLICES.entries()) {
    const file = path.join(directory, `${randomUUID()}.slice.png`);
    await exec('ffmpeg', ['-v','error','-y','-i',shot,'-frames:v','1','-vf',crop,file], {timeout:15000});
    slices.push({localPath:file, url:url.href, assetId:`${url.href}#view${index}`, sourceUrl:url.href, kind:'screenshot', score:index === 0 ? 6 : 3, text:`page screenshot interface ${url.hostname}`});
  }
  await fs.unlink(shot).catch(() => {});
  // ponytail: PNG size as an ink proxy; a slice under half the hero's size is footer whitespace on a short page.
  const sizes = await Promise.all(slices.map(slice => fs.stat(slice.localPath).then(stat => stat.size)));
  return slices.filter((_, index) => sizes[index] >= sizes[0] * 0.5);
}

// Identify the underlying picture behind CDN/proxy variants so the same artwork is never shown twice.
export function assetKey(url) {
  const decoded = decodeURIComponent(String(url));
  const nested = Math.max(decoded.lastIndexOf('https://'), decoded.lastIndexOf('http://'));
  const bare = (nested > 0 ? decoded.slice(nested) : decoded).split(/[?#]/)[0];
  return bare.replace(/\/(?:w|width|h|height|s|size)_?\d+(?=\/)/gi, '').toLowerCase();
}

const decode = s => s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
const JUNK = /favicon|tracking|pixel|spacer|avatar|profile_image|badge|emoji|sprite|\/flags\//i;
export function pageImages(html, base, query) {
  const terms = String(query).toLowerCase().split(/\W+/).filter(s => s.length > 2);
  const candidates = [];
  for (const tag of html.match(/<(?:meta|img|link)\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(),decode(m[2])]));
    const social = /^(og:image|twitter:image)(:url)?$/.test(attrs.property || attrs.name || '');
    const icon = /(?:^|\s)(?:apple-touch-)?icon(?:\s|$)/i.test(attrs.rel || '');
    const src = social ? attrs.content : icon ? attrs.href : attrs.src || attrs['data-src'];
    if (!src) continue;
    try {
      const url = new URL(src,base).href;
      if (!url.startsWith('https:') || JUNK.test(url)) continue;
      const text = `${attrs.alt || ''} ${url}`.toLowerCase();
      const matches = terms.filter(term => text.includes(term)).length;
      if (!social && !icon && !matches) continue;
      const kind = icon || /logo/i.test(text) ? 'logo' : 'screenshot';
      const iconScore = /apple-touch-icon/i.test(attrs.rel || '') ? 4 : icon ? 2 : 0;
      candidates.push({url,sourceUrl:base,kind,icon,score:matches*5+(social?8:0)+iconScore,social,alt:attrs.alt || '',text});
    } catch {}
  }
  return [...new Map(candidates.sort((a,b)=>b.score-a.score).map(c=>[c.url,c])).values()];
}

// README screenshots and diagrams are usually the most representative pictures of a developer tool.
export function readmeImages(markdown, repoUrl, query) {
  const {owner, repo} = repoUrl.match(/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/?#]+)/)?.groups ?? {};
  if (!owner) return [];
  const raw = `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/HEAD/`;
  const terms = String(query).toLowerCase().split(/\W+/).filter(s => s.length > 2);
  const found = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)].map(m => ({alt:m[1], src:m[2]}))
    .concat([...markdown.matchAll(/<img\b[^>]*>/gi)].map(m => {
      const attrs = Object.fromEntries([...m[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(a => [a[1].toLowerCase(), decode(a[2])]));
      return {alt:attrs.alt || '', src:attrs.src};
    }));
  const candidates = [];
  for (const {alt, src} of found) {
    if (!src || /\.svg(\?|$)/i.test(src) || /badge|shields\.io|img\.shields|actions\/workflows|codecov/i.test(src)) continue;
    try {
      const url = new URL(src, raw).href;
      if (!url.startsWith('https:')) continue;
      const text = `${alt} ${src}`.toLowerCase();
      const matches = terms.filter(term => text.includes(term)).length;
      candidates.push({url, sourceUrl:repoUrl, kind:/logo/i.test(text) ? 'logo' : 'screenshot', score:9 + matches*5 - candidates.length, alt, text:`readme ${text}`});
    } catch {}
  }
  return candidates;
}

export function isUsableVisualCue(cue, dialogue) {
  return Boolean(dialogue?.[Number(cue?.turn_index)] && String(cue?.phrase || '').trim());
}

const PURPOSES = ['identity','interface','mechanism','outcome','reaction','context'];
export const keyOf = candidate => candidate.assetId ?? assetKey(candidate.url);
// assetKey() strips URL fragments as CDN noise, but screenshotPage() deliberately uses
// #view0/#view1/#view2 as its assetId to keep distinct crops of the same page distinct
// (see keyOf and SCREENSHOT_SLICES) — stripping that fragment here would collapse three
// genuinely different pictures into one and undercount real, judge-approved visuals.
const finalAssetKey = value => /#view\d+$/.test(String(value)) ? String(value) : assetKey(value);
export function validateVisualSelection(visuals, {minimumImages = 8, requiredTurns = 6} = {}) {
  const distinctImages = new Set((visuals || []).map(visual => finalAssetKey(visual.assetUrl || visual.imagePath))).size;
  if (distinctImages < minimumImages) throw new Error(`VISUAL_PREFLIGHT_FAILED:${distinctImages}_DISTINCT_IMAGES`);
  if ((visuals || []).some(visual => !Number.isInteger(visual.startTurn) || visual.startTurn < 0 || visual.startTurn >= requiredTurns)) throw new Error('VISUAL_PREFLIGHT_FAILED:INVALID_TURN_INDEX');
  const coveredTurns = new Set((visuals || []).map(visual => visual.startTurn).filter(Number.isInteger));
  for (let turn = 0; turn < requiredTurns; turn++) if (!coveredTurns.has(turn)) throw new Error(`VISUAL_PREFLIGHT_FAILED:TURN_${turn}_UNCOVERED`);
  if ((visuals || []).some(visual => !String(visual.judgement || '').trim())) throw new Error('VISUAL_PREFLIGHT_FAILED:UNJUDGED_IMAGE');
  return {distinctImages, coveredTurns: requiredTurns};
}
export function purposeScore(candidate, purpose) {
  const description = `${candidate.alt || ''} ${candidate.text || ''}`.toLowerCase();
  if (purpose === 'identity') return (candidate.kind === 'logo' ? 12 : 0) + (candidate.social ? 4 : 0);
  if (purpose === 'interface') return /screenshot|dashboard|interface|editor|terminal|console|ui|demo/.test(description) ? 12 : (candidate.social ? -3 : 0);
  if (purpose === 'mechanism') return /diagram|architecture|workflow|pipeline|flow|agent|sandbox|readme/.test(description) ? 12 : (candidate.social ? -3 : 0);
  if (purpose === 'reaction') return /developer|person|people|thinking|confused|skeptical|smile|reaction/.test(description) ? 12 : 0;
  if (purpose === 'context') return /developer|computer|laptop|browser|tabs|workspace|context/.test(description) ? 12 : 0;
  return /result|output|benchmark|performance|comparison|chart|readme/.test(description) ? 12 : (candidate.social ? -3 : 0);
}

export function visualSearchQuery(tool, cue, query) {
  return cue?.kind === 'stock' ? String(query) : `${tool} ${query}`;
}

export const sourcePageFallbackAllowed = cue => cue?.kind !== 'stock';

const PREMIUM_STOCK = /(?:^|\.)plus\.unsplash\.com$|(?:^|\.)(?:gettyimages|istockphoto|freepik|shutterstock|alamy|dreamstime)\.com$|^stock\.adobe\.com$/;
export function candidateIsUsableStock(candidate) {
  for (const value of [candidate?.url, candidate?.sourceUrl]) {
    try { if (PREMIUM_STOCK.test(new URL(value).hostname.toLowerCase())) return false; }
    catch {}
  }
  return true;
}

const canonicalSource = value => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
};

const GITHUB_REPO = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/;

// The dialogue-writing model is told to cite "the exact product, documentation, repository, or
// evidence page" per cue, and sometimes invents a plausible-looking URL (a guessed docs path)
// that 404s instead of reusing a source research already verified. A cue built on a dead page
// never gets real page-scraped candidates and falls back to noisy generic search results, which
// tanks the sequence review. Screenshot cues get pinned to a verified claim source (or a
// well-formed GitHub repo, which githubReadmeCandidates validates on fetch) unless already one.
export function normalizeVisualCues(cues = [], {tool = 'the product', citedSource, sources = [], maxStock = 2} = {}) {
  const verified = new Set([citedSource, ...sources].filter(Boolean).map(canonicalSource));
  let stockCount = 0;
  return cues.map(cue => {
    let next = cue;
    if (next.kind === 'screenshot' && next.source_url && !verified.has(canonicalSource(next.source_url)) && !GITHUB_REPO.test(next.source_url)) {
      next = {...next, source_url: citedSource ?? next.source_url};
    }
    if (next.kind !== 'stock' || ++stockCount <= maxStock) return next;
    return {
      ...next,
      kind:'screenshot',
      visual_purpose:next.visual_purpose === 'context' ? 'mechanism' : 'evidence',
      query:`${tool} ${next.phrase} interface detail readable`,
      source_url:citedSource ?? next.source_url,
    };
  });
}

export function candidateMatchesCueSource(candidate, cue, sourceUrls = []) {
  // Only page-scraped candidates (og:image social cards, README images) can bleed in from
  // another claim's page — a live search result is already scoped to this cue's own query,
  // so locking it to the cue's source page just starves cues that share a cited article.
  if (cue?.kind !== 'screenshot' || candidate?.search) return true;
  const allowed = new Set([cue?.source_url, ...sourceUrls].map(canonicalSource).filter(Boolean));
  if (!allowed.size) return true;
  return allowed.has(canonicalSource(candidate?.sourceUrl));
}


// Keyless web image search. ponytail: DuckDuckGo's unofficial JSON endpoint; swap for Brave/Google CSE if it starts rate limiting.
export function parseSearchResults(json, query) {
  const results = Array.isArray(json?.results) ? json.results : [];
  return results.filter(r => r.image?.startsWith('https://') && Number(r.width) >= 400 && Number(r.height) >= 300).slice(0, 8)
    .map((r, index) => ({url:r.image, sourceUrl:r.url, kind:'screenshot', score:9 - index, search:true, title:String(r.title || ''), text:`search ${String(r.title || '')} ${r.image}`.toLowerCase(), query}));
}
export function parseBraveResults(json, query) {
  const results = Array.isArray(json?.results) ? json.results : [];
  return parseSearchResults({results: results.map(r => ({image:r.properties?.url, url:r.url, title:r.title, width:r.properties?.width ?? 1000, height:r.properties?.height ?? 800}))}, query);
}

// Self-hosted SearXNG (SEARXNG_URL, internal docker network — not routed through the SSRF-guarded
// getPublic() since it's our own trusted service, not arbitrary external content): aggregates Bing,
// DuckDuckGo, and whichever other image engines it has enabled into one JSON call. Diversifies across
// backends so one engine's rate limit or IP block doesn't zero out image search for a whole run.
export function parseSearxngResults(json, query) {
  const results = Array.isArray(json?.results) ? json.results : [];
  return results
    .filter(r => r.img_src?.startsWith('https://') && String(r.img_format || '').toLowerCase() !== 'svg')
    .filter(r => {
      const [w, h] = String(r.resolution || '').split(/[×x]/i).map(Number);
      return !r.resolution || (w >= 400 && h >= 300);
    })
    .slice(0, 8)
    .map((r, index) => ({url:r.img_src, sourceUrl:r.url, kind:'screenshot', score:9 - index, search:true, title:String(r.title || ''), text:`search ${String(r.title || '')} ${r.img_src}`.toLowerCase(), query}));
}
async function searchSearxng(query) {
  const res = await fetch(`${process.env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&categories=images&format=json`, {signal:AbortSignal.timeout(15000)});
  if (!res.ok) throw new Error(`SEARXNG_HTTP_${res.status}`);
  return parseSearxngResults(await res.json(), query);
}

// Plain keyless DDG image search: no browser, no Fortress. DDG's i.js JSON endpoint needs a `vqd`
// session token first, normally computed by DDG's own client-side JS on the search page; we scrape it
// out of the page's HTML instead of running a real browser to get it. Rate-limits under bursts (a full
// discovery run fires one of these per cue, back to back), so every call gets one backed-off retry and
// a small pacing delay up front; if DDG still 403s, the caller (discoverVisuals) just skips that cue
// rather than substituting a wrong image.
async function getPublicWithRetry(url, headers) {
  try {
    return await getPublic(url, 0, headers);
  } catch (error) {
    if (!/ASSET_HTTP_(403|429)/.test(error.message)) throw error;
    await sleep(2000);
    return getPublic(url, 0, headers);
  }
}
async function fetchDdgVqd(query) {
  const {body} = await getPublicWithRetry(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {'User-Agent':'Mozilla/5.0'});
  const match = body.toString().match(/vqd=['"]?([\d-]+)['"]?/);
  if (!match) throw new Error('DDG_VQD_NOT_FOUND');
  return match[1];
}
export async function searchImages(query) {
  const q = encodeURIComponent(query);
  // Keyed backend first when configured (untested here, kept behind the env var): https://api.search.brave.com/app/documentation
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const result = await getPublic(`https://api.search.brave.com/res/v1/images/search?q=${q}&count=8&safesearch=strict`, 0, {Accept:'application/json', 'X-Subscription-Token':process.env.BRAVE_SEARCH_API_KEY});
    return parseBraveResults(JSON.parse(result.body.toString()), query);
  }
  if (process.env.SEARXNG_URL) return searchSearxng(query);
  await sleep(500); // paces back-to-back cue searches so a full run doesn't burst DDG's rate limit
  const vqd = await fetchDdgVqd(query);
  const result = await getPublicWithRetry(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,&p=1`, {Accept:'application/json', Referer:'https://duckduckgo.com/'});
  return parseSearchResults(JSON.parse(result.body.toString()), query);
}

// Keyless, ToS-friendly source: the top GitHub repos for the tool, whose READMEs carry the real screenshots and diagrams.
export async function githubReadmeCandidates(tool, query, fetchPage) {
  const search = await getPublic(`https://api.github.com/search/repositories?q=${encodeURIComponent(tool)}&sort=stars&per_page=3`, 0, {Accept:'application/vnd.github+json'});
  const repos = (JSON.parse(search.body.toString()).items || []).map(item => item.full_name).filter(Boolean);
  const candidates = [];
  for (const repo of repos) {
    const readme = await fetchPage(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`);
    if (!readme.error) candidates.push(...readmeImages(readme.body.toString(), `https://github.com/${repo}`, query));
  }
  return candidates;
}

// Vision judge: Claude looks at the downloaded candidates and picks the one that illustrates the spoken line, or none.
const JUDGE_MODEL = process.env.ANTHROPIC_VISUAL_JUDGE_MODEL ?? 'claude-haiku-4-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export function parseJudgement(text, count) {
  const match = String(text).match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match?.[0] ?? '');
    const best = Number(parsed.best);
    return {
      index: Number.isInteger(best) && best >= 1 && best <= count ? best - 1 : null,
      reason: String(parsed.reason ?? ''),
      suggestedQuery: String(parsed.suggested_query ?? '').trim() || null,
    };
  } catch {return {index: null, reason: 'unparseable judgement', suggestedQuery: null};}
}
export function judgePrompt({tool, topic, turnText, phrase, purpose, kind, query}) {
  const purposes = {identity:'the tool\'s logo or brand mark', interface:'the tool\'s actual user interface, editor, terminal or dashboard', mechanism:'a diagram or code showing how it works', outcome:'a result, benchmark, chart, bill or comparison', reaction:'a human reaction that supports the dialogue beat', context:'an editorial scene that establishes the situation'};
  const selectionRule = kind === 'stock'
    ? 'This cue specifically calls for a stock photo or editorial illustration. People are acceptable when their expression or situation clearly matches the line. Reject product dashboards, logos, unrelated software interfaces, visible watermarks, and stock-preview overlays.'
    : `Reject stock photos, generic article headers, people, page navigation, cookie banners, ads, blank or unreadable images. A picture of a different product than ${tool} is acceptable only when the line is about a general concept; never when the line names, describes or praises ${tool}.`;
  return `Video topic: ${tool} — ${topic}.\nSpeaker line: "${turnText}"\nThe picture appears exactly when they say: "${phrase}"\nIntended picture: ${purposes[purpose]} (search query was "${query}").\n\nPick the ONE image a viewer would recognise as illustrating that line. Be strict: ${selectionRule} If none clearly fit, answer 0 and suggest a more specific web image search query that would actually find a picture proving this exact line — name the concrete thing to search for (a specific UI panel, a specific metric or chart, a specific diagram), not a rephrase of the line itself.\nReply with JSON only: {"best": <image number or 0>, "reason": "<short>", "suggested_query": "<only when best is 0>"}`;
}
async function judgeVisuals(context, downloaded) {
  if (!anthropic) return {index:null, reason:'vision judge unavailable', suggestedQuery:null};
  if (!downloaded.length) return {index:null, reason:'nothing downloadable', suggestedQuery:null};
  const content = [];
  for (const [index, item] of downloaded.entries()) {
    content.push({type:'text', text:`Image ${index + 1}: ${item.candidate.title || item.candidate.alt || item.candidate.kind} (from ${new URL(item.candidate.sourceUrl || item.candidate.url).hostname})`});
    content.push({type:'image', source:{type:'base64', media_type:'image/jpeg', data:(await fs.readFile(item.thumb)).toString('base64')}});
  }
  content.push({type:'text', text:judgePrompt(context)});
  const response = await anthropic.messages.create({model:JUDGE_MODEL, max_tokens:200, system:'You select pictures for short educational videos about developer tools. You only accept a picture that clearly and specifically illustrates what is being said.', messages:[{role:'user', content}]});
  return parseJudgement(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), downloaded.length);
}

export async function discoverVisuals(input) {
  try {
    await pruneGeneratedMedia({
      mediaRoot: MEDIA_ROOT,
      outputRoot: OUTPUT_ROOT,
      retentionDays: process.env.GENERATED_MEDIA_RETENTION_DAYS ?? 14,
    });
  } catch (error) {
    console.warn(`GENERATED_MEDIA_CLEANUP_FAILED:${error.message}`);
  }
  const run = randomUUID(); const directory = path.join(MEDIA_ROOT,'visuals',run);
  await fs.mkdir(directory,{recursive:true});
  const visuals = []; const report = []; const used = new Set(); const pages = new Map(); const screenshots = new Map();
  const sources = (input.research?.recommended_topic?.claims || []).map(c=>c.source_url).filter(Boolean);
  const tool = String(input.research?.recommended_topic?.tool_name || input.research?.recommended_topic?.topic || 'the tool');
  const cues = normalizeVisualCues((input.visualCues || []).slice(0,12), {tool, citedSource:sources[0], sources});
  const fetchPage = async url => {
    if (!pages.has(url)) pages.set(url, getPublic(url).catch(error => ({error})));
    return pages.get(url);
  };
  const fetchScreenshot = async url => {
    if (!screenshots.has(url)) screenshots.set(url, screenshotPage(url, directory).catch(error => ({error})));
    return screenshots.get(url);
  };
  const topic = String(input.research?.recommended_topic?.one_line_value || input.focus || '');
  const MAX_QUERY_ATTEMPTS = 5;
  for (const cue of cues) {
    if (!isUsableVisualCue(cue,input.dialogue)) {report.push({cue,status:'invalid_cue'}); continue;}
    const purpose = PURPOSES.includes(cue.visual_purpose) ? cue.visual_purpose : 'interface';
    const urls = [...new Set([cue.source_url,...sources].filter(Boolean))].slice(0,3);
    const shotUrls = new Set(); // shared across attempts for this cue: a page screenshot doesn't change with the query

    // One full search -> download -> judge cycle for a given query. Re-run with the judge's own
    // suggested_query (see judgePrompt) when it rejects everything, instead of leaving the cue empty
    // on the first miss.
    const runAttempt = async (attemptQuery) => {
      const candidates = [];
      const searchQuery = purpose === 'identity' ? `${tool} logo` : visualSearchQuery(tool, cue, attemptQuery);
      try {candidates.push(...await searchImages(searchQuery));} catch (error) {report.push({search:attemptQuery,error:error.message});}
      if (sourcePageFallbackAllowed(cue)) {
        try {candidates.push(...await githubReadmeCandidates(tool, attemptQuery, fetchPage));} catch (error) {report.push({github:tool,error:error.message});}
        for (const url of urls) {
          const response = await fetchPage(url);
          if (response.error) {report.push({sourceUrl:url,error:response.error.message}); continue;}
          // Social cards from other claim pages describe other articles, so only the cue's own page may contribute one.
          if (response.type.includes('text/html')) candidates.push(...pageImages(response.body.toString(),response.url,attemptQuery).filter(c => url === urls[0] || !c.social));
          if (/github\.com\/[^/]+\/[^/]+/.test(url)) {
            const readme = await fetchPage(`https://raw.githubusercontent.com/${url.match(/github\.com\/([^/]+\/[^/?#]+)/)[1].replace(/\.git$/,'')}/HEAD/README.md`);
            if (!readme.error) candidates.push(...readmeImages(readme.body.toString(), url, attemptQuery));
          }
        }
      }
      // Site icons only depict identity. A rendered source page joins the pool as the "interface" fallback.
      const tried = new Set();
      const rank = () => candidates.filter(c => candidateMatchesCueSource(c, cue, urls) && (cue.kind !== 'stock' || candidateIsUsableStock(c)) && (purpose === 'identity' || !c.icon) && !used.has(keyOf(c)) && !tried.has(keyOf(c))).sort((a,b)=>(b.score+purposeScore(b,purpose))-(a.score+purposeScore(a,purpose)));
      const addShot = async pageUrl => {
        if (!pageUrl || shotUrls.has(pageUrl)) return; shotUrls.add(pageUrl);
        const shot = await fetchScreenshot(pageUrl);
        if (shot.error) report.push({screenshot:pageUrl,error:shot.error.message}); else candidates.push(...shot);
      };
      // Download and validate the best-ranked unused candidates, then let the judge choose among what actually loaded.
      const download = async (limit = 8) => {
        const downloaded = [];
        for (const candidate of rank()) {
          if (downloaded.length >= limit) break;
          tried.add(keyOf(candidate));
          const temp = path.join(directory,`${randomUUID()}.download`);
          try {
            let body;
            if (candidate.localPath) body = await fs.readFile(candidate.localPath);
            else {
              const response = await getPublicWithRetry(candidate.url);
              if (!/^image\/(png|jpeg|webp|gif)/i.test(response.type)) throw new Error(`NOT_IMAGE:${response.type}`);
              body = response.body;
            }
            await fs.writeFile(temp,body);
            const {stdout} = await exec('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',temp],{timeout:10000});
            const dimensions = JSON.parse(stdout).streams[0];
            const minimumDimension = candidate.kind === 'logo' ? 120 : 320;
            if (!dimensions || Math.min(dimensions.width,dimensions.height)<minimumDimension || dimensions.width*dimensions.height>24000000) throw new Error('BAD_DIMENSIONS');
            const thumb = `${temp}.jpg`;
            await exec('ffmpeg',['-v','error','-y','-i',temp,'-frames:v','1','-vf','scale=768:768:force_original_aspect_ratio=decrease','-q:v','5',thumb],{timeout:15000});
            downloaded.push({candidate, temp, thumb, body});
          } catch (error) {report.push({url:candidate.url,error:error.message}); await fs.unlink(temp).catch(()=>{});}
        }
        return downloaded;
      };
      if (purpose !== 'identity' && sourcePageFallbackAllowed(cue)) await addShot(urls[0]);
      let downloaded = await download();
      if (sourcePageFallbackAllowed(cue)) for (const pageUrl of urls) { if (downloaded.length) break; await addShot(pageUrl); downloaded = await download(); }
      let judgement = {index:null, reason:'nothing downloadable', suggestedQuery:null};
      if (downloaded.length) {
        // A judge outage must never turn into a guessed picture: retry once, then leave the cue empty.
        const context = {tool, topic, turnText:input.dialogue[Number(cue.turn_index)].text, phrase:cue.phrase, purpose, kind:cue.kind, query:attemptQuery};
        try {judgement = await judgeVisuals(context, downloaded);}
        catch (first) {
          await sleep(3000);
          try {judgement = await judgeVisuals(context, downloaded);}
          catch (error) {report.push({judge:attemptQuery,error:error.message}); judgement = {index:null, reason:`judge unavailable: ${error.message}`, suggestedQuery:null};}
        }
      }
      return {downloaded, judgement};
    };

    let query = cue.query || cue.phrase;
    let downloaded = []; let judgement = {index:null, reason:'nothing downloadable', suggestedQuery:null};
    const attempts = [];
    for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
      ({downloaded, judgement} = await runAttempt(query));
      attempts.push({attempt, query, considered:downloaded.length, judgement:judgement.reason, suggestedQuery:judgement.suggestedQuery});
      if (judgement.index != null) break;
      for (const item of downloaded) {await fs.unlink(item.temp).catch(()=>{}); await fs.unlink(item.thumb).catch(()=>{});}
      downloaded = [];
      if (!judgement.suggestedQuery || attempt === MAX_QUERY_ATTEMPTS) break;
      query = judgement.suggestedQuery;
    }

    const pick = judgement.index != null ? downloaded[judgement.index] : null;
    let chosen;
    if (pick) {
      const filename = createHash('sha256').update(pick.body).digest('hex').slice(0,20)+'.png';
      await exec('ffmpeg',['-v','error','-y','-i',pick.temp,'-frames:v','1','-vf','scale=1200:1200:force_original_aspect_ratio=decrease',path.join(directory,filename)],{timeout:15000});
      used.add(keyOf(pick.candidate));
      chosen = {imagePath:`/media/visuals/${run}/${filename}`,title:query,kind:cue.kind === 'logo'?'logo':cue.kind === 'stock'?'stock':pick.candidate.kind,visualPurpose:purpose,startTurn:Number(cue.turn_index),phrase:cue.phrase,sourceUrl:pick.candidate.sourceUrl,assetUrl:pick.candidate.assetId ?? pick.candidate.url,judgement:judgement.reason,attribution:pick.candidate.attribution || null};
      visuals.push(chosen);
    }
    for (const item of downloaded) {await fs.unlink(item.temp).catch(()=>{}); await fs.unlink(item.thumb).catch(()=>{});}
    report.push({cue,status:chosen?'downloaded':'no_image',attempts,finalQuery:query,considered:downloaded.map(item => item.candidate.assetId ?? item.candidate.url),judgement:judgement.reason});
  }
  for (const shot of await Promise.all([...screenshots.values()])) if (!shot.error) for (const slice of shot) await fs.unlink(slice.localPath).catch(()=>{});
  let validation; let validationError;
  try { validation = validateVisualSelection(visuals); }
  catch (error) { validationError = error; report.push({status:'visual_preflight_failed',error:error.message}); }
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({visuals,report,validation:validation ?? null},null,2));
  if (validationError) throw validationError;
  return {...input,visuals,visualReport:report,visualValidation:validation};
}
