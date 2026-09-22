import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEmailContent, sendDistributionEmail} from './distribution-email.mjs';

const gitCliArm = {slug: 'git-cli', format: 'tips', avgEngagementRate: 0.2, sampleCount: 3, weight: 0.18, previousWeight: 0.1};
const editorIdeArm = {slug: 'editor-ide', format: 'tips', avgEngagementRate: 0.01, sampleCount: 3, weight: 0.05, previousWeight: 0.1};
const restingArms = ['agentic-ai:trend', 'databases-performance:tips', 'databases-performance:trend', 'debugging-observability:tips', 'debugging-observability:trend', 'editor-ide:trend', 'git-cli:trend', 'agentic-ai:tips']
  .map((key) => { const [slug, format] = key.split(':'); return {slug, format, avgEngagementRate: 0, sampleCount: 0, weight: 0.0844, previousWeight: 0.1}; });

const changedReport = {
  date: '2026-09-18',
  generatedAt: '2026-09-18T23:31:04.000Z',
  weightsChanged: true,
  skipReason: null,
  narrative: 'Git & CLI Tricks: Tips crushed it today, so its weight went up.',
  topPerformer: gitCliArm,
  bottomPerformer: editorIdeArm,
  leaderboard: [gitCliArm, editorIdeArm],
  arms: [gitCliArm, editorIdeArm, ...restingArms],
};

const insufficientReport = {
  date: '2026-09-19',
  generatedAt: '2026-09-19T23:31:04.000Z',
  weightsChanged: false,
  skipReason: 'INSUFFICIENT_SAMPLES',
  narrative: 'Not enough data yet.',
  topPerformer: null,
  bottomPerformer: null,
  leaderboard: [],
  arms: [{slug: 'git-cli', format: 'tips', avgEngagementRate: 0, sampleCount: 0, weight: 0.1, previousWeight: 0.1}],
};

test('buildEmailContent includes the narrative, date, and per-arm weight moves when weights changed', () => {
  const {subject, text} = buildEmailContent(changedReport);
  assert.match(subject, /2026-09-18/);
  assert.match(text, /crushed it today/);
  assert.match(text, /git-cli \(tips\): 20\.0% engagement, 3 post\(s\), weight 10\.0% -> 18\.0%/);
  assert.match(text, /editor-ide \(tips\)/);
});

test('buildEmailContent reports the skip reason plainly when weights are unchanged', () => {
  const {text} = buildEmailContent(insufficientReport);
  assert.match(text, /Weights unchanged \(INSUFFICIENT_SAMPLES\)/);
});

test('buildEmailContent produces valid, well-formed HTML with the narrative, top/bottom performers, and full leaderboard', () => {
  const {html} = buildEmailContent(changedReport);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Git &amp; CLI Tricks: Tips crushed it today/, 'narrative must be escaped, not raw HTML-injected');
  assert.match(html, /Did statistically well/);
  assert.match(html, /Did statistically worst/);
  assert.match(html, /git-cli \(tips\)/);
  assert.match(html, /editor-ide \(tips\)/);
  assert.match(html, /20\.0%/, 'top performer engagement rate must appear');
  assert.match(html, /Weights updated/);
  // Every opening <table appears with a matching </table> -- a cheap structural sanity check that
  // catches an unterminated template literal without needing a full HTML parser dependency.
  const opens = (html.match(/<table/g) || []).length;
  const closes = (html.match(/<\/table>/g) || []).length;
  assert.equal(opens, closes, 'every <table> must close');
});

test('buildEmailContent HTML escapes a narrative containing HTML-special characters instead of breaking markup', () => {
  const report = {...changedReport, narrative: 'Tool <script>alert(1)</script> & "quotes" scored well.'};
  const {html} = buildEmailContent(report);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp; &quot;quotes&quot;/);
});

test('buildEmailContent HTML lists resting arms (no fresh posts this window) separately from the ranked leaderboard', () => {
  const {html} = buildEmailContent(changedReport);
  assert.match(html, /No fresh posts this window/);
  assert.match(html, /agentic-ai \(trend\)/);
});

test('buildEmailContent HTML shows an insufficient-samples state without a leaderboard or performer cards', () => {
  const {html} = buildEmailContent(insufficientReport);
  assert.match(html, /No change/);
  assert.match(html, /insufficient samples/i);
  assert.doesNotMatch(html, /Did statistically well/);
  const opens = (html.match(/<table/g) || []).length;
  const closes = (html.match(/<\/table>/g) || []).length;
  assert.equal(opens, closes);
});

async function withEnv(vars, callback) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('sendDistributionEmail requires at least SMTP_USER when neither FROM nor TO is configured', async () => {
  await withEnv({DISTRIBUTION_REPORT_EMAIL_TO: '', DISTRIBUTION_REPORT_EMAIL_FROM: '', SMTP_USER: ''}, async () => {
    await assert.rejects(
      () => sendDistributionEmail({report: changedReport}),
      /DISTRIBUTION_EMAIL_NOT_CONFIGURED:SMTP_USER/,
    );
  });
});

test('sendDistributionEmail sends to yourself by default: an unset TO reuses the SMTP account', async () => {
  await withEnv({DISTRIBUTION_REPORT_EMAIL_TO: '', DISTRIBUTION_REPORT_EMAIL_FROM: '', SMTP_USER: 'me@gmail.com'}, async () => {
    let sent;
    const createTransport = () => ({sendMail: async (mail) => { sent = mail; return {messageId: '1'}; }});
    await sendDistributionEmail({report: changedReport}, {createTransport});
    assert.equal(sent.from, 'me@gmail.com');
    assert.equal(sent.to, 'me@gmail.com');
  });
});

test('sendDistributionEmail sends through the injected transport with the report subject/text', async () => {
  await withEnv({DISTRIBUTION_REPORT_EMAIL_TO: 'me@example.com', DISTRIBUTION_REPORT_EMAIL_FROM: 'reels@example.com'}, async () => {
    let sent;
    const createTransport = () => ({sendMail: async (mail) => { sent = mail; return {messageId: '<abc@example.com>'}; }});
    const result = await sendDistributionEmail({report: changedReport}, {createTransport});
    assert.equal(result.sent, true);
    assert.equal(result.messageId, '<abc@example.com>');
    assert.equal(sent.to, 'me@example.com');
    assert.equal(sent.from, 'reels@example.com');
    assert.match(sent.subject, /2026-09-18/);
    assert.match(sent.text, /crushed it today/);
  });
});

test('sendDistributionEmail falls back to SMTP_USER as the from address when DISTRIBUTION_REPORT_EMAIL_FROM is unset', async () => {
  await withEnv({DISTRIBUTION_REPORT_EMAIL_TO: 'me@example.com', DISTRIBUTION_REPORT_EMAIL_FROM: '', SMTP_USER: 'smtp-account@example.com'}, async () => {
    let sent;
    const createTransport = () => ({sendMail: async (mail) => { sent = mail; return {messageId: '1'}; }});
    await sendDistributionEmail({report: changedReport}, {createTransport});
    assert.equal(sent.from, 'smtp-account@example.com');
  });
});
