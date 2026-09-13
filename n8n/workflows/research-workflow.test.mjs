import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const workflowPath = new URL('./research-and-render-reel.json', import.meta.url);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

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

test('SEO brief is finalized before dialogue generation', () => {
  const seoNode = nodeById.get('finalize-seo-brief');
  assert.ok(seoNode, 'missing SEO brief finalizer');
  assert.match(seoNode.parameters.jsCode, /title_options/);
  assert.match(seoNode.parameters.jsCode, /related_keywords/);
  assert.equal(
    workflow.connections['Normalize Research Package'].main[0][0].node,
    'Finalize SEO Brief',
  );
  assert.equal(
    workflow.connections['Finalize SEO Brief'].main[0][0].node,
    'Build Peter and Stewie Dialogue Prompt',
  );
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
  const result = new Function('$json', promptNode.parameters.jsCode)({
    research: {recommended_topic: {tool_name: 'Agent Kit', claims: [{statement: 'It runs tools.'}]}},
    seo_brief: {primary_keyword: 'agent kit for developers'},
  });

  assert.equal(result.length, 1);
  assert.match(result[0].json.prompt, /exactly six/i);
  assert.match(result[0].json.prompt, /"turns"/);
  assert.match(result[0].json.prompt, /Peter introduces/i);
  assert.match(result[0].json.prompt, /Stewie/i);
  assert.match(result[0].json.prompt, /no strict upper word limit/);
  assert.match(result[0].json.prompt, /one primary tool/i);
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
  const jobs = Array.from({length:6},(_,i)=>({json:{speaker:i%2?'stewie':'peter',text:'Meet DeepSeek',turn_index:i,audio_path:'/media/voice.wav',visuals:[{turn_index:0,phrase:'DeepSeek',query:'DeepSeek logo'}]}}));
  const result = new Function('$items',nodeById.get('render-prep').parameters.jsCode)(name=>name==='Normalize Peter and Stewie Dialogue'?jobs:[{json:{research:{recommended_topic:{tool_name:'DeepSeek'}}}}]);
  assert.equal(result[0].json.visualCues[0].phrase,'DeepSeek');
  assert.equal(result[0].json.research.recommended_topic.tool_name,'DeepSeek');
  assert.deepEqual(result[0].json.characterImages, {peter: '/media/peter.png', stewie: '/media/stewie.png'});
  assert.equal(workflow.connections['Build Dialogue Audio and Subtitle Render Job'].main[0][0].node,'Find and Download Script Images');
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
});
