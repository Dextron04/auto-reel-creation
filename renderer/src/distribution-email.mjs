import nodemailer from 'nodemailer';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`DISTRIBUTION_EMAIL_NOT_CONFIGURED:${name}`);
  return value;
}

function defaultTransportFactory() {
  return nodemailer.createTransport({
    host: requireEnv('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {user: requireEnv('SMTP_USER'), pass: requireEnv('SMTP_PASSWORD')},
  });
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function pointsDelta(before, after) {
  const delta = (Number(after) - Number(before)) * 100;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}pp`;
}

function label(arm) {
  return arm ? `${arm.slug} (${arm.format})` : 'unknown';
}

function formatDate(dateString) {
  const parsed = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateString;
  return parsed.toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'});
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

// Plain text always accompanies the HTML -- some clients (and screen readers) prefer it, and it
// keeps the message useful even if a client strips the HTML part entirely.
function buildText(report) {
  const lines = [report.narrative || '(no narrative generated)', ''];
  if (report.weightsChanged) {
    lines.push('Weight changes today:');
    for (const arm of report.leaderboard ?? []) {
      lines.push(`  ${label(arm)}: ${pct(arm.avgEngagementRate)} engagement, ${arm.sampleCount} post(s), weight ${pct(arm.previousWeight)} -> ${pct(arm.weight)}`);
    }
  } else {
    lines.push(`Weights unchanged (${report.skipReason ?? 'insufficient samples'}).`);
  }
  const resting = (report.arms ?? []).filter((arm) => arm.sampleCount === 0);
  if (resting.length) lines.push('', `No fresh posts this window: ${resting.map(label).join(', ')}`);
  return lines.join('\n');
}

// --- design tokens -----------------------------------------------------------------------------
// A "print memo" reading of an ops digest: warm paper background, a serif voice for the narrative
// Claude wrote, and a monospace voice for every number -- the two typefaces do the job a chart
// legend would, letting a reader's eye separate "what happened" prose from "the actual data" at a
// glance without any extra labeling.
const INK = '#1c1a17';
const MUTED = '#6f6a61';
const PAGE_BG = '#f4f1ea';
const CARD_BG = '#ffffff';
const RULE = '#e4ded2';
const UP = '#2f6f4f';
const UP_BG = '#e8f2ec';
const DOWN = '#a1442f';
const DOWN_BG = '#f7e9e4';
const GOLD = '#b8860b';
const BAR_TRACK = '#e4ded2';
const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', serif";
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace";

function weightBar(weight, maxWeight) {
  const fillPercent = maxWeight > 0 ? Math.max(2, Math.round((weight / maxWeight) * 100)) : 0;
  return `<table role="presentation" width="72" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:72px;"><tr>
    <td style="background:${BAR_TRACK};border-radius:3px;padding:0;height:8px;line-height:8px;font-size:0;">
      <table role="presentation" width="${fillPercent}%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
        <td style="background:${GOLD};border-radius:3px;height:8px;line-height:8px;font-size:0;">&nbsp;</td>
      </tr></table>
    </td>
  </tr></table>`;
}

function performerCard({arm, kind}) {
  const positive = kind === 'top';
  const color = positive ? UP : DOWN;
  const bg = positive ? UP_BG : DOWN_BG;
  const heading = positive ? 'Did statistically well' : 'Did statistically worst';
  const arrow = positive ? '&#9650;' : '&#9660;';
  const sidePadding = positive ? '0 8px 0 0' : '0 0 0 8px';
  return `<td class="perf-col" width="50%" valign="top" style="padding:${sidePadding};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:${bg};border-radius:8px;">
      <tr><td style="padding:16px 18px;">
        <div style="font:600 11px/1.4 ${MONO};letter-spacing:.06em;text-transform:uppercase;color:${color};">${arrow} ${heading}</div>
        <div style="font:700 18px/1.3 ${SERIF};color:${INK};margin-top:6px;">${escapeHtml(label(arm))}</div>
        <div style="font:13px/1.6 ${MONO};color:${MUTED};margin-top:8px;">
          ${pct(arm.avgEngagementRate)} engagement &middot; ${arm.sampleCount} post${arm.sampleCount === 1 ? '' : 's'}<br/>
          weight ${pct(arm.previousWeight)} &rarr; <b style="color:${color};">${pct(arm.weight)}</b> (${pointsDelta(arm.previousWeight, arm.weight)})
        </div>
      </td></tr>
    </table>
  </td>`;
}

function leaderboardRow(arm, rank, maxWeight) {
  const delta = Number(arm.weight) - Number(arm.previousWeight);
  const deltaColor = delta > 0 ? UP : delta < 0 ? DOWN : MUTED;
  return `<tr>
    <td style="padding:10px 8px;border-bottom:1px solid ${RULE};font:13px ${MONO};color:${MUTED};">${rank}</td>
    <td style="padding:10px 8px;border-bottom:1px solid ${RULE};font:600 14px ${SERIF};color:${INK};">${escapeHtml(label(arm))}</td>
    <td style="padding:10px 8px;border-bottom:1px solid ${RULE};font:13px ${MONO};color:${INK};text-align:right;">${pct(arm.avgEngagementRate)}</td>
    <td style="padding:10px 8px;border-bottom:1px solid ${RULE};font:13px ${MONO};color:${MUTED};text-align:right;">${arm.sampleCount}</td>
    <td style="padding:10px 8px;border-bottom:1px solid ${RULE};font:13px ${MONO};color:${deltaColor};text-align:right;white-space:nowrap;">${pct(arm.weight)} <span style="color:${MUTED};">(${pointsDelta(arm.previousWeight, arm.weight)})</span></td>
    <td class="bar-col" style="padding:10px 8px 10px 14px;border-bottom:1px solid ${RULE};">${weightBar(arm.weight, maxWeight)}</td>
  </tr>`;
}

function restingArmsBlock(report) {
  const resting = (report.arms ?? []).filter((arm) => arm.sampleCount === 0);
  if (!resting.length) return '';
  return `<div style="font:12px/1.7 ${MONO};color:${MUTED};margin-top:18px;padding-top:14px;border-top:1px dashed ${RULE};">
    No fresh posts this window (weight held): ${resting.map((arm) => escapeHtml(label(arm))).join(', ')}
  </div>`;
}

function allArmsTable(report, maxWeight) {
  const sorted = [...(report.arms ?? [])].sort((a, b) => b.weight - a.weight);
  const rows = sorted.map((arm, index) => `<tr>
    <td style="padding:8px;border-bottom:1px solid ${RULE};font:12px ${MONO};color:${MUTED};">${index + 1}</td>
    <td style="padding:8px;border-bottom:1px solid ${RULE};font:13px ${SERIF};color:${INK};">${escapeHtml(label(arm))}</td>
    <td style="padding:8px;border-bottom:1px solid ${RULE};font:12px ${MONO};color:${MUTED};text-align:right;">${arm.sampleCount}</td>
    <td style="padding:8px;border-bottom:1px solid ${RULE};font:12px ${MONO};color:${INK};text-align:right;">${pct(arm.weight)}</td>
    <td class="bar-col" style="padding:8px 8px 8px 14px;border-bottom:1px solid ${RULE};">${weightBar(arm.weight, maxWeight)}</td>
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:10px;">
    <tr>
      <th align="left" style="padding:0 8px 6px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">#</th>
      <th align="left" style="padding:0 8px 6px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Arm</th>
      <th align="right" style="padding:0 8px 6px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Posts</th>
      <th align="right" style="padding:0 8px 6px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Weight</th>
      <th class="bar-col" style="padding:0 8px 6px 14px;border-bottom:1px solid ${RULE};"></th>
    </tr>
    ${rows}
  </table>`;
}

function buildHtml(report) {
  const arms = report.arms ?? [];
  const maxWeight = arms.length ? Math.max(...arms.map((arm) => Number(arm.weight) || 0)) : 0.1;
  const statusPositive = report.weightsChanged === true;
  const statusLabel = statusPositive ? 'Weights updated' : `No change — ${escapeHtml(report.skipReason ?? 'insufficient samples').toLowerCase().replace(/_/g, ' ')}`;

  const leaderboardSection = (report.leaderboard ?? []).length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px;">
        <tr>
          <th align="left" style="padding:0 8px 8px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">#</th>
          <th align="left" style="padding:0 8px 8px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Arm</th>
          <th align="right" style="padding:0 8px 8px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Engagement</th>
          <th align="right" style="padding:0 8px 8px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Posts</th>
          <th align="right" style="padding:0 8px 8px;font:600 11px ${MONO};letter-spacing:.04em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${RULE};">Weight</th>
          <th class="bar-col" style="padding:0 8px 8px 14px;border-bottom:1px solid ${RULE};"></th>
        </tr>
        ${report.leaderboard.map((arm, index) => leaderboardRow(arm, index + 1, maxWeight)).join('')}
      </table>`
    : '';

  const performersSection = (report.topPerformer && report.bottomPerformer)
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:20px;"><tr>
        ${performerCard({arm: report.topPerformer, kind: 'top'})}
        ${performerCard({arm: report.bottomPerformer, kind: 'bottom'})}
      </tr></table>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  /* Data tables don't shrink below their content width on their own -- below 480px the decorative
     weight-bar column is dropped (the percentage next to it already carries the number) and the
     two performer cards stack instead of sitting side by side, so the numbers stay readable
     instead of forcing horizontal scroll. Ignored by clients that strip <style>; the table still
     works, it just keeps its desktop column set. */
  @media screen and (max-width: 480px) {
    .pad-x { padding-left:16px !important; padding-right:16px !important; }
    .bar-col { display:none !important; }
    .perf-col { display:block !important; width:100% !important; padding:0 0 8px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:${PAGE_BG};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;width:100%;background:${CARD_BG};border-radius:12px;overflow:hidden;border:1px solid ${RULE};">

        <tr><td class="pad-x" style="background:${INK};padding:20px 28px;">
          <div style="font:600 11px/1.4 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:#b8b2a4;">Auto Reel Pipeline</div>
          <div style="font:700 24px/1.3 ${SERIF};color:#ffffff;margin-top:4px;">Distribution Report</div>
          <div style="font:12px/1.5 ${MONO};color:#8f8a7c;margin-top:6px;">${escapeHtml(formatDate(report.date))}</div>
        </td></tr>

        <tr><td class="pad-x" style="padding:20px 28px 0;">
          <span style="display:inline-block;font:600 11px ${MONO};letter-spacing:.04em;padding:5px 10px;border-radius:20px;background:${statusPositive ? UP_BG : '#efece3'};color:${statusPositive ? UP : MUTED};">${statusLabel}</span>
        </td></tr>

        <tr><td class="pad-x" style="padding:16px 28px 4px;">
          <div style="border-left:3px solid ${GOLD};padding:2px 0 2px 16px;font:17px/1.6 ${SERIF};color:${INK};">${escapeHtml(report.narrative || 'No narrative generated for this run.')}</div>
        </td></tr>

        ${performersSection ? `<tr><td class="pad-x" style="padding:8px 28px 0;">${performersSection}</td></tr>` : ''}

        ${leaderboardSection ? `<tr><td class="pad-x" style="padding:24px 28px 0;">
          <div style="font:600 11px ${MONO};letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;">Full ranking</div>
          ${leaderboardSection}
        </td></tr>` : ''}

        <tr><td class="pad-x" style="padding:24px 28px 0;">
          <div style="font:600 11px ${MONO};letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;">All 10 arms, current weight</div>
          ${allArmsTable(report, maxWeight)}
          ${restingArmsBlock(report)}
        </td></tr>

        <tr><td class="pad-x" style="padding:22px 28px 26px;border-top:1px solid ${RULE};margin-top:20px;">
          <div style="font:11px/1.7 ${MONO};color:${MUTED};padding-top:20px;word-break:break-word;">
            Generated ${escapeHtml(report.generatedAt ?? '')} &middot; full data at <span style="color:${INK};">GET /v1/distribution/report?date=${escapeHtml(report.date)}</span>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function buildEmailContent(report) {
  const subject = `Reel distribution report — ${report.date}`;
  return {subject, text: buildText(report), html: buildHtml(report)};
}

export async function sendDistributionEmail({report}, {createTransport = defaultTransportFactory} = {}) {
  const from = process.env.DISTRIBUTION_REPORT_EMAIL_FROM || requireEnv('SMTP_USER');
  // Sending to yourself is the common case, so an unset TO reuses the SMTP account itself rather
  // than demanding a second address be configured for the same mailbox.
  const to = process.env.DISTRIBUTION_REPORT_EMAIL_TO || from;
  const {subject, text, html} = buildEmailContent(report);
  const transport = createTransport();
  const info = await transport.sendMail({from, to, subject, text, html});
  return {sent: true, messageId: info.messageId};
}
