import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const workflowPath = new URL('./research-and-render-reel.json', import.meta.url);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

test('workflow exposes a private manual webhook through the same production pipeline', () => {
  const trigger = workflow.nodes.find((node) => node.name === 'Run from Dashboard');

  assert.equal(trigger?.type, 'n8n-nodes-base.webhook');
  assert.equal(trigger?.parameters?.httpMethod, 'POST');
  assert.equal(trigger?.parameters?.path, 'reel-dashboard-run');
  assert.equal(
    workflow.connections['Run from Dashboard']?.main?.[0]?.[0]?.node,
    'Fetch OpenAI News',
  );
});

test('research workflow includes broad developer-tool discovery sources', () => {
  const sourceIds = [
    'rss-openai',
    'rss-google-ai',
    'rss-huggingface',
    'rss-github-changelog',
    'rss-github-ai',
    'rss-dev-ai',
    'rss-product-hunt',
    'rss-aws-ml',
    'rss-vercel',
    'rss-jetbrains-idea',
    'rss-hackernews',
  ];

  for (const sourceId of sourceIds) assert.ok(nodeById.has(sourceId), `missing ${sourceId}`);
  assert.equal(nodeById.get('merge-research-feeds').parameters.numberInputs, sourceIds.length);
});

test('trend scoring runs before the research prompt', () => {
  const scoreNode = nodeById.get('score-developer-tool-trends');
  assert.ok(scoreNode, 'missing deterministic trend scoring node');
  assert.match(scoreNode.parameters.jsCode, /trend_score/);
  assert.match(scoreNode.parameters.jsCode, /developer_relevance/);
  assert.equal(
    workflow.connections['Merge Research Sources'].main[0][0].node,
    'Score Developer Tool Trends',
  );
  assert.equal(
    workflow.connections['Score Developer Tool Trends'].main[0][0].node,
    'Fetch Recent Topics',
  );
  assert.equal(
    workflow.connections['Fetch Recent Topics'].main[0][0].node,
    'Build Research Prompt',
  );
});

test('Claude is the primary researcher and local Qwen is the fallback', () => {
  const claudeNode = nodeById.get('research-claude');
  const routeNode = nodeById.get('route-claude-research');
  const fallbackNode = nodeById.get('4af79882-30e9-4996-84a2-b4a0e62e818d');
  const decisionNode = nodeById.get('claude-research-available');

  assert.ok(claudeNode, 'missing Claude research node');
  assert.ok(routeNode, 'missing Claude response router');
  assert.ok(decisionNode, 'missing Claude fallback decision');
  assert.equal(fallbackNode.name, 'Research with Local Qwen Fallback');
  assert.equal(claudeNode.parameters.url, 'https://api.anthropic.com/v1/messages');
  assert.match(JSON.stringify(claudeNode.parameters.headerParameters), /ANTHROPIC_API_KEY/);
  assert.match(JSON.stringify(claudeNode.parameters.headerParameters), /anthropic-version/);
  assert.match(claudeNode.parameters.jsonBody, /ANTHROPIC_MODEL/);
  assert.match(claudeNode.parameters.jsonBody, /claude-haiku-4-5-20251001/);
  // The 5-candidate research schema (full evidence + SEO brief per candidate) genuinely needs
  // ~8-9k output tokens; a live run against claude-haiku-4-5-20251001 confirmed 4096 truncates
  // mid-JSON (stop_reason: max_tokens) and 8192 still does. Keep real headroom above that.
  const [, defaultMaxTokens] = claudeNode.parameters.jsonBody.match(/ANTHROPIC_MAX_TOKENS \|\| (\d+)/) ?? [];
  assert.ok(Number(defaultMaxTokens) >= 16000, `default max_tokens (${defaultMaxTokens}) is too low for the 5-candidate research schema`);
  assert.equal(claudeNode.parameters.options.neverError, true);
  assert.equal(claudeNode.parameters.options.response.response.fullResponse, true);

  assert.equal(workflow.connections['Build Research Prompt'].main[0][0].node, 'Research with Claude');
  assert.equal(workflow.connections['Research with Claude'].main[0][0].node, 'Route Claude Research Result');
  assert.equal(workflow.connections['Route Claude Research Result'].main[0][0].node, 'Claude Research Available?');
  assert.equal(workflow.connections['Claude Research Available?'].main[0][0].node, 'Normalize Research Package');
  assert.equal(workflow.connections['Claude Research Available?'].main[1][0].node, 'Research with Local Qwen Fallback');
  assert.equal(workflow.connections['Research with Local Qwen Fallback'].main[0][0].node, 'Normalize Research Package');
});

test('Claude result router accepts useful text and falls back on exhausted credits or empty output', () => {
  const routeCode = nodeById.get('route-claude-research').parameters.jsCode;
  const items = () => [{json: {prompt: 'Research current developer tools'}}];
  const run = (json) => new Function('$json', '$items', routeCode)(json, items);

  const success = run({
    statusCode: 200,
    body: {
      model: 'claude-sonnet-5',
      content: [{type: 'text', text: '{"recommended_topic":{"claims":[{"statement":"Useful"}]}}'}],
    },
  });
  assert.equal(success[0].json.use_qwen_fallback, false);
  assert.equal(success[0].json.research_provider, 'anthropic');
  assert.match(success[0].json.response, /recommended_topic/);

  const exhausted = run({statusCode: 429, body: {error: {type: 'rate_limit_error'}}});
  assert.equal(exhausted[0].json.use_qwen_fallback, true);
  assert.equal(exhausted[0].json.prompt, 'Research current developer tools');
  assert.match(exhausted[0].json.fallback_reason, /429.*rate_limit_error/);

  const empty = run({statusCode: 200, body: {content: []}});
  assert.equal(empty[0].json.use_qwen_fallback, true);
  assert.match(empty[0].json.fallback_reason, /empty_response/);

});

test('research normalization accepts Claude fenced multiline JSON and Qwen NDJSON', () => {
  const normalizeCode = nodeById.get('a0732238-b8e3-4919-add5-39e6eb9576c0').parameters.jsCode;
  const research = {recommended_topic: {claims: [{statement: 'Useful'}]}};
  const claude = new Function('$json', normalizeCode)({
    response: `\`\`\`json\n${JSON.stringify(research, null, 2)}\n\`\`\`\nResearch notes complete.`,
    research_provider: 'anthropic',
    research_model: 'claude-haiku-4-5-20251001',
  });
  assert.deepEqual(claude[0].json.research, research);
  assert.equal(claude[0].json.research_provider, 'anthropic');

  const qwenStream = [
    JSON.stringify({response: '{"recommended_topic":'}),
    JSON.stringify({response: '{"claims":[{"statement":"Useful"}]}}'}),
  ].join('\n');
  const qwen = new Function('$json', normalizeCode)(qwenStream);
  assert.deepEqual(qwen[0].json.research, research);
});

test('research normalization recovers from a truncated (unclosed) code fence', () => {
  const normalizeCode = nodeById.get('a0732238-b8e3-4919-add5-39e6eb9576c0').parameters.jsCode;
  const research = {recommended_topic: {claims: [{statement: 'Useful'}]}};
  // Reproduces a real qwen-fallback failure: generation stopped before the closing ``` ever
  // arrived, so the naive fenced-block regex never matches and JSON.parse chokes on the backtick.
  const truncated = new Function('$json', normalizeCode)({
    response: `\`\`\`json\n${JSON.stringify(research, null, 2)}`,
    research_provider: 'qwen-fallback',
    research_model: 'tushin-agent:latest',
  });
  assert.deepEqual(truncated[0].json.research, research);

  assert.throws(() => new Function('$json', normalizeCode)({response: 'not json at all'}), /RESEARCH_INVALID_JSON/);
});

test('research prompt requests actionable developer and SEO output', () => {
  const promptCode = nodeById.get('af5f69ff-5d43-439d-80bf-b74085e60214').parameters.jsCode;
  for (const requiredText of [
    'agent harnesses',
    'developer_workflow',
    'primary_keyword',
    'search_intent',
    'hashtags',
    'trend_score',
  ]) {
    assert.match(promptCode, new RegExp(requiredText), `prompt is missing ${requiredText}`);
  }
});

test('research prompt asks for category breadth and avoids recently covered topics', () => {
  const promptCode = nodeById.get('af5f69ff-5d43-439d-80bf-b74085e60214').parameters.jsCode;
  const scored = Array.from({length: 6}, (_, i) => ({json: {
    source_url: `https://example.com/${i}`, publisher: 'example.com', trend_score: 90 - i, title: `Item ${i}`,
  }}));
  const items = (name) => name === 'Score Developer Tool Trends' ? scored : [];
  const fn = new Function('$items', '$json', promptCode);

  const withHistory = fn(items, {recent: [{tool_name: 'AI SDK Harness Layer', category: 'Agent Harness', topic: 'Durable agent execution'}]});
  assert.match(withHistory[0].json.prompt, /PERMANENT EXCLUSION ARCHIVE.*AI SDK Harness Layer: Durable agent execution \(Agent Harness\)/s);
  assert.match(withHistory[0].json.prompt, /databases, security, performance engineering/);

  const withoutHistory = fn(items, {recent: []});
  assert.doesNotMatch(withoutHistory[0].json.prompt, /PERMANENT EXCLUSION ARCHIVE/);

  const missingHistoryResponse = fn(items, undefined);
  assert.equal(missingHistoryResponse.length, 1, 'a failed topic-history fetch must not break research');
});

test('research prompt balances source material across categories before repeating one', () => {
  const promptCode = nodeById.get('af5f69ff-5d43-439d-80bf-b74085e60214').parameters.jsCode;
  const categories = ['agents', 'agents', 'agents', 'databases', 'security', 'testing'];
  const scored = categories.map((content_category, index) => ({json: {
    source_url: `https://example.com/${index}`,
    publisher: `publisher-${index}.com`,
    trend_score: 100 - index,
    content_category,
  }}));
  const items = (name) => name === 'Score Developer Tool Trends' ? scored : [];

  const result = new Function('$items', '$json', promptCode)(items, {recent: []});
  const firstFourCategories = result[0].json.sources.slice(0, 4).map((item) => item.content_category);

  assert.equal(new Set(firstFourCategories).size, 4);
});

test('research prompt requires every fallback candidate to contain complete evidence', () => {
  const promptCode = nodeById.get('af5f69ff-5d43-439d-80bf-b74085e60214').parameters.jsCode;
  const scored = Array.from({length: 5}, (_, index) => ({json: {
    source_url: `https://example.com/${index}`,
    publisher: `publisher-${index}.com`,
    trend_score: 90 - index,
    content_category: 'testing',
  }}));
  const items = (name) => name === 'Score Developer Tool Trends' ? scored : [];

  const result = new Function('$items', '$json', promptCode)(items, {recent: []});

  assert.match(result[0].json.prompt, /Every candidate must include the full evidence and SEO fields/i);
});

test('SEO brief is finalized before dialogue generation', () => {
  const seoNode = nodeById.get('finalize-seo-brief');
  assert.ok(seoNode, 'missing SEO brief finalizer');
  assert.match(seoNode.parameters.jsCode, /title_options/);
  assert.match(seoNode.parameters.jsCode, /related_keywords/);
  assert.equal(
    workflow.connections['Normalize Research Package'].main[0][0].node,
    'Select Unused Topic',
  );
  assert.equal(
    workflow.connections['Select Unused Topic'].main[0][0].node,
    'Finalize SEO Brief',
  );
  assert.equal(
    workflow.connections['Finalize SEO Brief'].main[0][0].node,
    'Build Peter and Stewie Dialogue Prompt',
  );
});

test('a topic is recorded only after a video renders successfully', () => {
  const recordNode = nodeById.get('record-topic-history');
  assert.ok(recordNode, 'missing record-topic-history node');
  assert.notEqual(recordNode.parameters.options.neverError, true, 'losing permanent history must fail visibly');
  assert.match(recordNode.parameters.jsonBody, /tool_name/);
  assert.match(recordNode.parameters.jsonBody, /recommended_topic/);
  assert.equal(workflow.connections['Render 9:16 Reel with Subtitles'].main[0][0].node, 'Record Topic to History');
  assert.equal(workflow.connections['Record Topic to History'].main[0][0].node, 'Build Instagram Caption Prompt');
});

test('normalized research is checked against permanent history before scripting', () => {
  const selectNode = nodeById.get('select-unused-topic');
  assert.ok(selectNode, 'missing hard duplicate-selection node');
  assert.equal(selectNode.parameters.url, 'http://renderer:3001/v1/topic-history/select');
  assert.notEqual(selectNode.parameters.options.neverError, true, 'duplicate exhaustion must stop the run');
  assert.match(selectNode.parameters.jsonBody, /research/);
});

test('recent topics are fetched before the research prompt is built, without blocking on failure', () => {
  const fetchNode = nodeById.get('fetch-recent-topics');
  assert.ok(fetchNode, 'missing fetch-recent-topics node');
  assert.equal(fetchNode.parameters.options.neverError, true, 'a history-read failure must not fail the run');
  assert.equal(workflow.connections['Score Developer Tool Trends'].main[0][0].node, 'Fetch Recent Topics');
  assert.equal(workflow.connections['Fetch Recent Topics'].main[0][0].node, 'Build Research Prompt');
});

test('research workflow includes a general software engineering source alongside AI vendor feeds', () => {
  const hn = nodeById.get('rss-hackernews');
  assert.ok(hn, 'missing Hacker News source');
  assert.equal(hn.parameters.url, 'https://hnrss.org/frontpage');
  const merge = nodeById.get('merge-research-feeds');
  assert.equal(merge.parameters.numberInputs, 11, 'merge must accept all 11 feeds');
});

test('trend scoring keeps developer tools and ranks stronger signals first', () => {
  const scoreCode = nodeById.get('score-developer-tool-trends').parameters.jsCode;
  const recent = new Date().toISOString();
  const fixtures = [
    ['OpenAI agent harness adds tracing and evals', 'https://openai.com/tools/agent-harness', 'An SDK for developer agent workflows, tool calling, testing, and observability.'],
    ['GitHub coding agent adds MCP support', 'https://github.blog/changelog/coding-agent-mcp', 'A developer coding agent with MCP automation and sandbox testing.'],
    ['Vercel ships AI SDK workflow tools', 'https://vercel.com/changelog/ai-sdk-workflows', 'An SDK and API for agentic developer workflow deployment.'],
    ['JetBrains IDE adds agent mode', 'https://blog.jetbrains.com/idea/agent-mode', 'An IDE coding agent for debugging and developer automation.'],
    ['DEV guide to open source evals', 'https://dev.to/example/open-source-evals', 'Developer testing and evaluation tools for AI agents.'],
    ['Consumer wallpaper collection', 'https://producthunt.com/posts/wallpapers', 'A collection of phone backgrounds.'],
  ].map(([title, link, contentSnippet]) => ({json: {title, link, contentSnippet, isoDate: recent}}));

  const result = new Function('$input', scoreCode)({all: () => fixtures});
  assert.ok(result.length >= 5);
  assert.equal(result[0].json.publisher, 'openai.com');
  assert.ok(result.every((item) => item.json.developer_relevance >= 5));
  assert.ok(result.every((item) => Number.isFinite(item.json.trend_score)));
});

test('trend scoring classifies stories so category balancing has real inputs', () => {
  const scoreCode = nodeById.get('score-developer-tool-trends').parameters.jsCode;
  const recent = new Date().toISOString();
  const fixtures = [
    ['PostgreSQL database adds async I/O API', 'https://example.com/postgres', 'Database performance for developers.'],
    ['Critical dependency vulnerability fixed', 'https://example.com/security', 'Developer security patch for a package supply chain vulnerability.'],
    ['New unit testing framework', 'https://example.com/testing', 'Developer test automation and evaluation framework.'],
    ['Coding agent adds MCP tools', 'https://example.com/agent', 'Agentic coding workflow with tool calling.'],
    ['Deployment CLI cuts build time', 'https://example.com/deploy', 'Developer deployment performance tooling.'],
  ].map(([title, link, contentSnippet]) => ({json: {title, link, contentSnippet, isoDate: recent}}));

  const result = new Function('$input', scoreCode)({all: () => fixtures});
  const categories = new Set(result.map((item) => item.json.content_category));

  assert.ok(categories.has('databases'));
  assert.ok(categories.has('security'));
  assert.ok(categories.has('testing'));
  assert.ok(categories.has('agents'));
});

test('publisher parsing works in the restricted n8n Code sandbox', () => {
  const scoreCode = nodeById.get('score-developer-tool-trends').parameters.jsCode;
  const recent = new Date().toISOString();
  const fixtures = Array.from({length: 5}, (_, index) => ({
    json: {
      title: `OpenAI coding agent SDK ${index}`,
      link: `https://openai.com/tools/agent-${index}`,
      contentSnippet: 'Developer coding agent SDK with API automation and testing.',
      isoDate: recent,
    },
  }));
  const result = runInNewContext(`(() => { ${scoreCode} })()`, {$input: {all: () => fixtures}});
  assert.equal(result[0].json.publisher, 'openai.com');
  assert.equal(result[0].json.authority_score, 18);
});

test('script prompt requests a six-turn Peter and Stewie dialogue', () => {
  const promptNode = nodeById.get('script-prompt');
  const seoBriefItem = {json: {
    research: {recommended_topic: {tool_name: 'Agent Kit', claims: [{statement: 'It runs tools.'}]}},
    seo_brief: {primary_keyword: 'agent kit for developers'},
  }};
  const items = (name) => name === 'Finalize SEO Brief' ? [seoBriefItem] : [];
  const result = new Function('$items', '$json', promptNode.parameters.jsCode)(items, {});

  assert.equal(result.length, 1);
  assert.equal(result[0].json.seo_brief.primary_keyword, 'agent kit for developers');
  assert.match(result[0].json.prompt, /exactly six/i);
  assert.match(result[0].json.prompt, /"turns"/);
  assert.match(result[0].json.prompt, /Peter introduces/i);
  assert.match(result[0].json.prompt, /Stewie/i);
  assert.match(result[0].json.prompt, /8–12 distinct visual cues/);
  assert.match(result[0].json.prompt, /Claude Vision will reject irrelevant candidates/);
  assert.match(result[0].json.prompt, /government documents/);
  assert.match(result[0].json.prompt, /one primary tool/i);
  // Live executions twice generated cues that skipped a turn entirely (turn_index 0-5 not all
  // covered), which only ever failed much later in visual discovery. This is a hard requirement
  // with a self-check instruction, not the single soft clause it used to be.
  assert.match(result[0].json.prompt, /hard requirement, not a suggestion/);
  assert.match(result[0].json.prompt, /turn_index 0, 1, 2, 3, 4, and 5 each appear at least once/);
  assert.match(result[0].json.prompt, /one sentence/i);
  assert.match(result[0].json.prompt, /do not combine unrelated products/i);
  assert.match(result[0].json.prompt, /visuals/i);
  assert.match(result[0].json.prompt, /phrase/i);
  assert.match(result[0].json.prompt, /visual_purpose/i);
});

test('Claude is the primary dialogue writer and local Qwen is the fallback', () => {
  const claudeNode = nodeById.get('dialogue-claude');
  const routeNode = nodeById.get('route-claude-dialogue');
  const decisionNode = nodeById.get('claude-dialogue-available');
  const fallbackNode = nodeById.get('script-qwen');

  assert.ok(claudeNode, 'missing Claude dialogue node');
  assert.ok(routeNode, 'missing Claude dialogue response router');
  assert.ok(decisionNode, 'missing Claude dialogue fallback decision');
  assert.equal(fallbackNode.name, 'Write Peter and Stewie Dialogue with Qwen Fallback');
  assert.equal(claudeNode.parameters.url, 'https://api.anthropic.com/v1/messages');
  assert.match(JSON.stringify(claudeNode.parameters.headerParameters), /ANTHROPIC_API_KEY/);
  assert.match(claudeNode.parameters.jsonBody, /ANTHROPIC_MODEL/);
  assert.match(claudeNode.parameters.jsonBody, /claude-haiku-4-5-20251001/);
  assert.equal(claudeNode.parameters.options.neverError, true);
  assert.equal(claudeNode.parameters.options.response.response.fullResponse, true);

  assert.equal(workflow.connections['Build Peter and Stewie Dialogue Prompt'].main[0][0].node, 'Write Peter and Stewie Dialogue with Claude');
  assert.equal(workflow.connections['Write Peter and Stewie Dialogue with Claude'].main[0][0].node, 'Route Claude Dialogue Result');
  assert.equal(workflow.connections['Route Claude Dialogue Result'].main[0][0].node, 'Claude Dialogue Available?');
  assert.equal(workflow.connections['Claude Dialogue Available?'].main[0][0].node, 'Normalize Peter and Stewie Dialogue');
  assert.equal(workflow.connections['Claude Dialogue Available?'].main[1][0].node, 'Write Peter and Stewie Dialogue with Qwen Fallback');
  assert.equal(workflow.connections['Write Peter and Stewie Dialogue with Qwen Fallback'].main[0][0].node, 'Normalize Peter and Stewie Dialogue');
});

test('Claude dialogue router accepts text and falls back on credits, errors, or empty output', () => {
  const routeCode = nodeById.get('route-claude-dialogue').parameters.jsCode;
  const promptItem = {json: {prompt: 'Write six dialogue turns', research: {recommended_topic: {tool_name: 'Agent Kit'}}, seo_brief: {primary_keyword: 'agent kit'}}};
  const items = () => [promptItem];
  const run = (json) => new Function('$json', '$items', routeCode)(json, items);

  const validTurns = Array.from({length: 6}, (_, index) => ({
    speaker: index % 2 === 0 ? 'peter' : 'stewie',
    text: 'This valid dialogue turn has exactly eight useful words.',
  }));
  const success = run({statusCode: 200, body: {model: 'claude-haiku-4-5-20251001', content: [{type: 'text', text: JSON.stringify({turns: validTurns})}]}});
  assert.equal(success[0].json.use_qwen_fallback, false);
  assert.equal(success[0].json.dialogue_provider, 'anthropic');
  assert.equal(success[0].json.research.recommended_topic.tool_name, 'Agent Kit');

  const exhausted = run({statusCode: 402, body: {error: {type: 'billing_error'}}});
  assert.equal(exhausted[0].json.use_qwen_fallback, true);
  assert.equal(exhausted[0].json.prompt, 'Write six dialogue turns');
  assert.match(exhausted[0].json.fallback_reason, /402.*billing_error/);

  const empty = run({statusCode: 200, body: {content: []}});
  assert.equal(empty[0].json.use_qwen_fallback, true);
  assert.match(empty[0].json.fallback_reason, /empty_response/);

  const overlongTurns = Array.from({length: 6}, (_, index) => ({
    speaker: index % 2 === 0 ? 'peter' : 'stewie',
    text: 'This deliberately long dialogue turn contains far more words than a short vertical video script would traditionally use and keeps adding detail because a longer reel is acceptable now.',
  }));
  const overlong = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: overlongTurns})}]}});
  assert.equal(overlong[0].json.use_qwen_fallback, false, 'long dialogue is no longer rejected on word count');

  const tooShortTurns = Array.from({length: 6}, (_, index) => ({speaker: index % 2 === 0 ? 'peter' : 'stewie', text: 'Too short.'}));
  const tooShort = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({turns: tooShortTurns})}]}});
  assert.equal(tooShort[0].json.use_qwen_fallback, true);
  assert.match(tooShort[0].json.fallback_reason, /invalid_dialogue/);
});

test('dialogue normalization emits alternating voice jobs and rejects bad ordering', () => {
  const normalizeNode = nodeById.get('dialogue-normalize');
  assert.ok(normalizeNode, 'missing dialogue normalization node');
  const valid = {
    response: JSON.stringify({
      title: 'Agent Kit',
      focus: 'Tool orchestration',
      source_start_seconds: 12,
      turns: [
        {speaker: 'peter', text: 'Developers, meet Agent Kit, the tool that removes repetitive integration work.'},
        {speaker: 'stewie', text: 'Why do developers actually need another agent tool for that?'},
        {speaker: 'peter', text: 'It connects tools through one observable workflow instead of custom glue.'},
        {speaker: 'stewie', text: 'And how would anyone use that in a real project?'},
        {speaker: 'peter', text: 'Teams automate tool calls while keeping each run easier to inspect.'},
        {speaker: 'stewie', text: 'Fine. Less glue code could save developers actual time.'},
      ],
      visuals: [{kind: 'logo', title: 'Agent Kit', github_repo: 'example/agent-kit', start_turn: 0, end_turn: 1}],
    }),
  };
  const jobs = new Function('$json', normalizeNode.parameters.jsCode)(valid);

  assert.equal(jobs.length, 6);
  assert.deepEqual(jobs.map((job) => job.json.speaker), ['peter', 'stewie', 'peter', 'stewie', 'peter', 'stewie']);
  assert.deepEqual(jobs.map((job) => job.json.turn_index), [0, 1, 2, 3, 4, 5]);
  assert.ok(jobs.every((job) => job.json.dialogue.length === 6));
  assert.equal(jobs[0].json.visuals[0].github_repo, 'example/agent-kit');

  const invalid = {response: JSON.stringify({...JSON.parse(valid.response), turns: JSON.parse(valid.response).turns.map((turn, index) => index === 1 ? {...turn, speaker: 'peter'} : turn)})};
  assert.throws(() => new Function('$json', normalizeNode.parameters.jsCode)(invalid), /DIALOGUE_SPEAKER_ORDER/);

  const fenced = {response: `\`\`\`json\n${JSON.stringify(JSON.parse(valid.response), null, 2)}\n\`\`\`\nDialogue ready.`};
  const fencedJobs = new Function('$json', normalizeNode.parameters.jsCode)(fenced);
  assert.equal(fencedJobs.length, 6);
});

test('render job preserves script cues and research for image collection', () => {
  const fullCoverage = Array.from({length:6},(_,i)=>({turn_index:i,phrase:'DeepSeek',query:'DeepSeek logo'}));
  const jobs = Array.from({length:6},(_,i)=>({json:{speaker:i%2?'stewie':'peter',text:'Meet DeepSeek',turn_index:i,audio_path:'/media/voice.wav',visuals:fullCoverage}}));
  const result = new Function('$items',nodeById.get('render-prep').parameters.jsCode)(name=>name==='Normalize Peter and Stewie Dialogue'?jobs:[{json:{research:{recommended_topic:{tool_name:'DeepSeek'}}}}]);
  assert.equal(result[0].json.visualCues[0].phrase,'DeepSeek');
  assert.equal(result[0].json.research.recommended_topic.tool_name,'DeepSeek');
  assert.deepEqual(result[0].json.characterImages, {peter: '/media/peter.png', stewie: '/media/stewie.png'});
  assert.equal(workflow.connections['Build Dialogue Audio and Subtitle Render Job'].main[0][0].node,'Find and Download Script Images');
});

test('render prep fails fast when a turn has no visual cue at all, before any image search', () => {
  // Reproduces a real production failure: Claude wrote cues for turns [0,0,2,2,3,4,5,5],
  // skipping turn 1 entirely, despite the script prompt asking for every turn covered. The old
  // code only caught this at the very end of visual discovery (VISUAL_PREFLIGHT_FAILED:5_TURNS_COVERED),
  // after burning the whole search/download/judge budget on a run that was already doomed.
  const gappyCues = [0,0,2,2,3,4,5,5].map((turn_index)=>({turn_index,phrase:'DeepSeek',query:'DeepSeek screenshot'}));
  const jobs = Array.from({length:6},(_,i)=>({json:{speaker:i%2?'stewie':'peter',text:'Meet DeepSeek',turn_index:i,audio_path:'/media/voice.wav',visuals:gappyCues}}));
  const run = () => new Function('$items',nodeById.get('render-prep').parameters.jsCode)(name=>name==='Normalize Peter and Stewie Dialogue'?jobs:[{json:{research:{recommended_topic:{tool_name:'DeepSeek'}}}}]);
  assert.throws(run, /DIALOGUE_CUES_MISSING_TURNS:5_OF_6/);
});

test('dialogue voice generation routes each turn to the matching configured voice', () => {
  const ttsNode = nodeById.get('tts-dialogue-turn');
  const saveNode = nodeById.get('save-dialogue-turn');
  assert.ok(ttsNode, 'missing per-turn TTS node');
  assert.ok(saveNode, 'missing per-turn audio writer');
  assert.match(ttsNode.parameters.jsonBody, /TTS_STEWIE_VOICE/);
  assert.match(ttsNode.parameters.jsonBody, /TTS_PETER_VOICE/);
  assert.match(ttsNode.parameters.jsonBody, /\$json\.text/);
  assert.match(saveNode.parameters.fileName, /turn_index/);
  assert.match(saveNode.parameters.fileName, /speaker/);
  // Live execution failed the whole run on a single slow response from the external TTS
  // service (120s proxy timeout) — this call had no retry at all, unlike the Claude/qwen
  // fallback paths elsewhere in the workflow.
  assert.equal(ttsNode.retryOnFail, true);
  assert.ok(ttsNode.maxTries >= 2);
});

test('Instagram caption prompt includes the tool context, dialogue, and JSON instruction', () => {
  const promptNode = nodeById.get('instagram-caption-prompt');
  assert.ok(promptNode, 'missing instagram-caption-prompt node');
  const context = {json: {
    research: {recommended_topic: {tool_name: 'Agent Kit', hook: 'Stop writing glue code', one_line_value: 'One interface for every coding agent', seo_brief: {related_keywords: ['agent kit'], hashtags: ['#AgentKit', '#DevTools']}}},
    dialogue: [{speaker: 'peter', text: 'Meet Agent Kit.'}, {speaker: 'stewie', text: 'Why do I care?'}],
  }};
  const items = () => [context];
  const result = new Function('$json', '$items', promptNode.parameters.jsCode)({render: {outputLocation: '/output/reel-1.mp4'}}, items);
  assert.equal(result.length, 1);
  assert.match(result[0].json.prompt, /Agent Kit/);
  assert.match(result[0].json.prompt, /Meet Agent Kit\./);
  assert.match(result[0].json.prompt, /Return ONLY JSON/);
  assert.equal(result[0].json.outputLocation, '/output/reel-1.mp4');
  assert.deepEqual(result[0].json.seo_brief.hashtags, ['#AgentKit', '#DevTools']);
});

test('Instagram caption router combines Claude output or falls back to the SEO brief', () => {
  const routeNode = nodeById.get('route-instagram-caption');
  assert.ok(routeNode, 'missing route-instagram-caption node');
  const promptItem = {json: {outputLocation: '/output/reel-1.mp4', seo_brief: {description: 'Agent Kit gives every coding agent one interface.', hashtags: ['#AgentKit', '#DevTools', '#Coding']}}};
  const items = () => [promptItem];
  const run = (json) => new Function('$json', '$items', routeNode.parameters.jsCode)(json, items);

  const success = run({statusCode: 200, body: {content: [{type: 'text', text: JSON.stringify({caption: 'Stop writing glue code for every coding agent.', hashtags: ['#AgentKit', '#DevTools']})}]}});
  assert.equal(success[0].json.captionSource, 'claude');
  assert.match(success[0].json.caption, /Stop writing glue code/);
  assert.match(success[0].json.caption, /#AgentKit #DevTools/);
  assert.equal(success[0].json.outputLocation, '/output/reel-1.mp4');

  const httpError = run({statusCode: 500, body: {error: {type: 'server_error'}}});
  assert.equal(httpError[0].json.captionSource, 'seo_fallback');
  assert.match(httpError[0].json.caption, /Agent Kit gives every coding agent one interface\./);
  assert.match(httpError[0].json.caption, /#AgentKit #DevTools #Coding/);

  const badJson = run({statusCode: 200, body: {content: [{type: 'text', text: 'Sure, here you go without json'}]}});
  assert.equal(badJson[0].json.captionSource, 'seo_fallback');
});
