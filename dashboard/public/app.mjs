import {manualRunPresentation} from './presenters.mjs';

const $ = (selector, element = document) => element.querySelector(selector);
const $$ = (selector, element = document) => [...element.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[character]);
const LIVE_POLL_MS = 2500;
const IDLE_POLL_MS = 10000;
const STAGE_ORDER = ['discover', 'script', 'voice', 'visuals', 'quality', 'render', 'publish', 'prepare'];
const STAGE_LABELS = {discover:'Discover', script:'Plan & write', voice:'Voice', visuals:'Visuals', quality:'Quality gate', render:'Render', publish:'Publish', prepare:'Prepare'};

const state = {
  executions: [],
  workflowNodes: [],
  videos: [],
  nextCursor: null,
  nextRunAt: null,
  nextRunLabel: null,
  apiConfigured: null,
  historyExpanded: false,
  executionFilter: 'all',
  manualRunStarting: false,
  manualRunError: null,
  executionTimer: null,
  executionLoading: false,
};

function fmtDate(value) {
  return value ? new Date(value).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '—';
}

function durationSeconds(start, stop = new Date()) {
  if (!start) return null;
  return Math.max(0, Math.floor((new Date(stop) - new Date(start)) / 1000));
}

function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fmtBytes(bytes) {
  return bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtNodeDuration(milliseconds) {
  if (!milliseconds) return '';
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
}

async function getJSON(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || response.statusText), {body});
  return body;
}

function markSynced(label = null) {
  $('#syncDot').className = 'sync-dot online';
  $('#lastUpdated').textContent = label ?? `Live · updated ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit', second:'2-digit'})}`;
}

function markDelayed(message = 'Refresh delayed') {
  $('#syncDot').className = 'sync-dot delayed';
  $('#lastUpdated').textContent = message;
}

function service(name, health, detail) {
  const tone = health === true ? 'good' : health === false ? 'bad' : 'warn';
  return `<div class="service"><span class="service-dot ${tone}"></span><strong>${escapeHtml(name)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

async function loadStatus() {
  const status = await getJSON('/api/status');
  const workflow = status.n8n.workflow;
  state.apiConfigured = status.n8n.apiConfigured;
  $('#services').innerHTML = [
    service('Renderer', status.renderer.ok, status.renderer.ok ? 'ready' : 'offline'),
    service('n8n', status.n8n.ok, status.n8n.ok ? 'connected' : 'offline'),
    service('Workflow', workflow ? workflow.active : null, workflow ? (workflow.active ? 'scheduled' : 'paused') : 'unknown'),
    service('API', status.n8n.apiConfigured ? true : null, status.n8n.apiConfigured ? 'live data' : 'key missing'),
  ].join('');
  $('#workflowSummary').textContent = workflow
    ? `${workflow.nodeCount ?? state.workflowNodes.length} production nodes · ${workflow.active ? 'scheduled automation is active' : 'workflow is paused'}. Live execution data refreshes every few seconds.`
    : 'Connect the n8n API to inspect the production workflow and its live node state.';
  const banners = [...(status.envWarnings ?? [])];
  if (status.n8n.error) banners.push({level:'bad', message:`n8n API: ${status.n8n.error}`});
  $('#banners').innerHTML = banners.map(item => `<div class="banner ${escapeHtml(item.level ?? 'warn')}">${escapeHtml(item.message)}</div>`).join('');
  renderManualRunControl();
  markSynced();
}

function renderNextRun() {
  if (!state.nextRunAt) return;
  const next = new Date(state.nextRunAt);
  $('#nextRunTime').textContent = state.nextRunLabel ?? '—';
  const seconds = Math.floor((next - new Date()) / 1000);
  $('#nextRunDetail').textContent = seconds > 0 ? `Starts in ${fmtDuration(seconds)}` : 'Refreshing schedule…';
}

async function loadSchedule() {
  const schedule = await getJSON('/api/schedule');
  $('#cronInput').value = schedule.cron ?? '';
  state.nextRunAt = schedule.nextRunAt;
  state.nextRunLabel = schedule.nextRunLabel;
  if (schedule.active === false) {
    $('#nextRunTime').textContent = 'Paused';
    $('#nextRunDetail').textContent = 'Activate the workflow in n8n to resume';
  } else if (schedule.nextRunAt) renderNextRun();
  else {
    $('#nextRunTime').textContent = 'Unavailable';
    $('#nextRunDetail').textContent = 'Check the configured cron expression';
  }
  $('#scheduleSource').textContent = `${schedule.source === 'n8n' ? 'Live n8n schedule' : 'Checked-in schedule'} · ${schedule.timezone}`;
}

function executionLabel(status) {
  return ({success:'Succeeded', error:'Failed', crashed:'Crashed', running:'Running', waiting:'Waiting', new:'Starting', canceled:'Canceled'})[status] ?? String(status || 'Unknown');
}

function normalizedNodeStates(execution) {
  if (execution.nodeStates?.length) return execution.nodeStates;
  const active = new Set(execution.currentNodes ?? []);
  return state.workflowNodes.map(node => ({...node, state:active.has(node.name) ? 'active' : 'queued', durationMs:null}));
}

function renderLive() {
  const execution = state.executions.find(item => item.status === 'running');
  const badge = $('#liveBadge');
  if (!execution) {
    badge.className = 'live-badge';
    badge.textContent = state.apiConfigured === false ? 'Disconnected' : 'Standing by';
    const latest = state.executions[0];
    $('#liveExecution').innerHTML = `<div class="monitor-empty">
      <span class="idle-mark">Ⅱ</span>
      <strong>${state.apiConfigured === false ? 'Live data unavailable' : 'Pipeline is standing by'}</strong>
      <p>${state.apiConfigured === false ? 'Add N8N_API_KEY to show active nodes and execution history.' : latest ? `Last execution ${escapeHtml(executionLabel(latest.status).toLowerCase())} ${escapeHtml(fmtDate(latest.stoppedAt ?? latest.startedAt))}.` : 'The node rail will appear here as soon as a run starts.'}</p>
    </div>`;
    return;
  }

  badge.className = 'live-badge active';
  badge.textContent = 'Live';
  const nodes = normalizedNodeStates(execution);
  const activeNodes = nodes.filter(node => node.state === 'active');
  const completed = nodes.filter(node => node.state === 'complete').length;
  const progress = execution.progressPercent ?? (nodes.length ? Math.round((completed / nodes.length) * 100) : 0);
  const groups = STAGE_ORDER.map(stage => ({stage, nodes:nodes.filter(node => node.stage === stage)})).filter(group => group.nodes.length);
  const activeNames = activeNodes.length ? activeNodes.map(node => node.name) : (execution.currentNodes?.length ? execution.currentNodes : [execution.lastNode ?? 'Starting workflow']);

  $('#liveExecution').innerHTML = `
    <div class="execution-head">
      <div><span class="execution-id">EXECUTION #${escapeHtml(execution.id)}</span><h3>${escapeHtml(STAGE_LABELS[activeNodes[0]?.stage] ?? 'Production in progress')}</h3></div>
      <span class="execution-timer" data-started="${escapeHtml(execution.startedAt)}">${escapeHtml(fmtDuration(durationSeconds(execution.startedAt)))}</span>
    </div>
    <div class="progress-meta"><span>${completed} of ${nodes.length || '—'} nodes complete</span><span>${progress}%</span></div>
    <div class="progress-track" role="progressbar" aria-label="Workflow progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><div class="progress-fill" style="width:${progress}%"></div></div>
    <div class="active-node-block"><span class="active-node-label">Working now</span><strong>${activeNames.map(escapeHtml).join(' + ')}</strong><small>Node state refreshes every ${LIVE_POLL_MS / 1000} seconds while this execution is active.</small></div>
    <div class="stage-list" aria-label="Workflow node progress">${groups.map(group => {
      const complete = group.nodes.filter(node => node.state === 'complete').length;
      const hasActive = group.nodes.some(node => node.state === 'active');
      const hasFailed = group.nodes.some(node => node.state === 'failed');
      const stageProgress = group.nodes.length ? Math.round((complete / group.nodes.length) * 100) : 0;
      return `<details class="stage${hasActive ? ' has-active' : ''}" ${hasActive || hasFailed ? 'open' : ''}>
        <summary><span class="stage-name">${escapeHtml(STAGE_LABELS[group.stage] ?? group.stage)}</span><span class="stage-bar"><span style="width:${stageProgress}%"></span></span><span class="stage-count">${complete}/${group.nodes.length}</span></summary>
        <ul class="node-rail">${group.nodes.map(node => `<li class="pipeline-node ${escapeHtml(node.state)}"><span>${escapeHtml(node.name)}</span><span class="node-duration">${escapeHtml(fmtNodeDuration(node.durationMs))}</span></li>`).join('')}</ul>
      </details>`;
    }).join('')}</div>`;
}

function renderMetrics() {
  const completed = state.executions.filter(item => !['running', 'new', 'waiting'].includes(item.status));
  const successes = completed.filter(item => item.status === 'success').length;
  const failures = completed.filter(item => ['error', 'crashed'].includes(item.status)).length;
  const durations = completed.map(item => durationSeconds(item.startedAt, item.stoppedAt)).filter(Number.isFinite);
  const average = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
  const values = [
    {value:completed.length ? `${Math.round((successes / completed.length) * 100)}%` : '—', note:`${completed.length} measured`},
    {value:fmtDuration(average), note:'completed runs'},
    {value:String(failures), note:`of ${completed.length} runs`},
    {value:String(state.videos.length), note:'rendered videos'},
  ];
  $$('.metric').forEach((element, index) => {
    $('strong', element).textContent = values[index].value;
    $('small', element).textContent = values[index].note;
  });
}

function renderHistory() {
  const rows = state.executions.filter(execution => state.executionFilter === 'all' || execution.status === state.executionFilter || (state.executionFilter === 'error' && execution.status === 'crashed'));
  $('#executionCount').textContent = `${state.executions.length} loaded`;
  if (!rows.length) {
    $('#executions').innerHTML = `<div class="content-empty">${state.executions.length ? 'No executions match this filter.' : 'No executions have been recorded yet.'}</div>`;
  } else {
    $('#executions').innerHTML = `<div class="execution-list">${rows.map(execution => {
      const node = execution.currentNodes?.[0] ?? execution.lastNode ?? 'No node reported';
      const seconds = durationSeconds(execution.startedAt, execution.stoppedAt ?? new Date());
      return `<details class="execution-record">
        <summary>
          <span class="execution-status ${escapeHtml(execution.status)}">${escapeHtml(executionLabel(execution.status))}</span>
          <span class="record-primary"><strong>${escapeHtml(node)}</strong><small>Execution #${escapeHtml(execution.id)}</small></span>
          <time class="record-time">${escapeHtml(fmtDate(execution.startedAt))}</time>
          <span class="record-duration">${escapeHtml(fmtDuration(seconds))}</span>
          <span class="record-chevron">+</span>
        </summary>
        <div class="execution-detail">
          <div class="detail-item"><span>Execution</span><strong>#${escapeHtml(execution.id)}</strong></div>
          <div class="detail-item"><span>Mode</span><strong>${escapeHtml(execution.mode ?? '—')}</strong></div>
          <div class="detail-item"><span>Started</span><strong>${escapeHtml(fmtDate(execution.startedAt))}</strong></div>
          <div class="detail-item"><span>Stopped</span><strong>${escapeHtml(fmtDate(execution.stoppedAt))}</strong></div>
          ${execution.error ? `<div class="detail-error"><strong>Failure at ${escapeHtml(execution.lastNode ?? 'unknown node')}:</strong> ${escapeHtml(execution.error)}</div>` : ''}
        </div>
      </details>`;
    }).join('')}</div>`;
  }
  $('#loadMoreWrap').hidden = !state.nextCursor;
  renderMetrics();
}

function renderManualRunControl() {
  const running = state.executions.find(execution => execution.status === 'running');
  const view = manualRunPresentation({runningExecutionId:running?.id ?? null, starting:state.manualRunStarting, error:state.manualRunError});
  const unavailable = state.apiConfigured === false;
  $$('.run-workflow').forEach(button => {
    button.disabled = unavailable || view.disabled;
    const label = $('.run-label', button);
    if (label) label.textContent = unavailable ? 'Connect n8n API' : view.label;
    button.title = unavailable ? 'N8N_API_KEY is required' : view.message;
  });
  $('#manualRunMessage').innerHTML = view.error ? `<span class="bad-text">${escapeHtml(view.message)}</span>` : escapeHtml(unavailable ? 'Add N8N_API_KEY to start and monitor workflows.' : view.message);
  $('#manualRunState').textContent = running ? 'Running' : state.manualRunStarting ? 'Starting' : view.error ? 'Needs attention' : 'Standby';
}

async function loadExecutions(reset = true) {
  if (state.executionLoading) return;
  state.executionLoading = true;
  try {
    const cursor = reset ? null : state.nextCursor;
    const data = await getJSON(`/api/executions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    state.apiConfigured = data.configured;
    if (!data.configured) {
      state.executions = [];
      state.workflowNodes = [];
      renderLive();
      renderHistory();
      renderManualRunControl();
      return;
    }
    if (data.error) throw new Error(data.error);
    state.workflowNodes = data.workflowNodes ?? state.workflowNodes;
    if (reset) {
      const incomingIds = new Set(data.executions.map(item => item.id));
      state.executions = state.historyExpanded
        ? [...data.executions, ...state.executions.filter(item => !incomingIds.has(item.id))]
        : data.executions;
      if (!state.historyExpanded) state.nextCursor = data.nextCursor;
    } else {
      const existingIds = new Set(state.executions.map(item => item.id));
      state.executions = [...state.executions, ...data.executions.filter(item => !existingIds.has(item.id))];
      state.nextCursor = data.nextCursor;
      state.historyExpanded = true;
    }
    renderLive();
    renderHistory();
    renderManualRunControl();
    markSynced();
  } catch (error) {
    markDelayed('Live execution refresh delayed');
    if (!state.executions.length) {
      $('#liveExecution').innerHTML = `<div class="monitor-empty"><strong>Execution data unavailable</strong><p>${escapeHtml(error.message)}</p></div>`;
      $('#executions').innerHTML = `<div class="content-empty">Could not load execution history. Check the n8n connection and try again.</div>`;
    }
  } finally {
    state.executionLoading = false;
    scheduleExecutionRefresh();
  }
}

function scheduleExecutionRefresh() {
  clearTimeout(state.executionTimer);
  if (document.hidden) return;
  const active = state.executions.some(execution => execution.status === 'running');
  state.executionTimer = setTimeout(() => loadExecutions(true), active ? LIVE_POLL_MS : IDLE_POLL_MS);
}

async function loadVideos() {
  state.videos = await getJSON('/api/videos');
  $('#videoCount').textContent = `${state.videos.length} released`;
  if (!state.videos.length) {
    $('#videos').innerHTML = '<div class="content-empty">No rendered videos yet. A completed render will appear here with its quality counts.</div>';
  } else {
    $('#videos').innerHTML = state.videos.map(video => `<details class="video-card">
      <summary><div><div class="video-name">${escapeHtml(video.file)}</div><div class="video-meta"><span>${escapeHtml(fmtDate(video.createdAt))}</span><span>${escapeHtml(fmtDuration(video.durationSeconds))}</span><span>${escapeHtml(video.visualCount ?? '—')} visuals</span><span>${escapeHtml(video.captionCount ?? '—')} captions</span></div></div><span class="video-play">▶</span></summary>
      <div class="video-player"><video controls preload="none" playsinline src="${escapeHtml(video.url)}"></video><div class="video-meta"><span>${escapeHtml(fmtBytes(video.sizeBytes))}</span></div></div>
    </details>`).join('');
  }
  renderMetrics();
}

async function startWorkflow() {
  if (state.manualRunStarting) return;
  state.manualRunStarting = true;
  state.manualRunError = null;
  renderManualRunControl();
  try {
    await getJSON('/api/run', {method:'POST'});
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 650));
      await loadExecutions(true);
      if (state.executions.some(execution => execution.status === 'running')) break;
    }
  } catch (error) {
    state.manualRunError = error.message;
  } finally {
    state.manualRunStarting = false;
    renderManualRunControl();
  }
}

async function refreshAll() {
  const button = $('#refreshDashboard');
  button.classList.add('loading');
  await Promise.allSettled([loadStatus(), loadSchedule(), loadExecutions(true), loadVideos()]);
  button.classList.remove('loading');
}

$$('.run-workflow').forEach(button => button.addEventListener('click', startWorkflow));
$$('.preset').forEach(button => button.addEventListener('click', () => { $('#cronInput').value = button.dataset.cron; }));
$$('.filter').forEach(button => button.addEventListener('click', () => {
  state.executionFilter = button.dataset.filter;
  $$('.filter').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
  renderHistory();
}));
$('#refreshDashboard').addEventListener('click', refreshAll);
$('#loadMore').addEventListener('click', () => loadExecutions(false));
$('#saveSchedule').addEventListener('click', async () => {
  const message = $('#scheduleMsg');
  message.textContent = 'Saving schedule…';
  try {
    const result = await getJSON('/api/schedule', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cron:$('#cronInput').value.trim()})});
    message.innerHTML = `<span class="good-text">Schedule saved.</span>${result.fileWarning ? ` <span class="warn-text">${escapeHtml(result.fileWarning)}</span>` : ''}`;
    await Promise.all([loadSchedule(), loadStatus()]);
  } catch (error) {
    message.innerHTML = `<span class="bad-text">${escapeHtml(error.message)}</span>`;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(state.executionTimer);
  else refreshAll();
});
setInterval(() => {
  renderNextRun();
  $$('[data-started]').forEach(element => { element.textContent = fmtDuration(durationSeconds(element.dataset.started)); });
}, 1000);
setInterval(() => Promise.allSettled([loadStatus(), loadSchedule(), loadVideos()]), 30000);

refreshAll();
