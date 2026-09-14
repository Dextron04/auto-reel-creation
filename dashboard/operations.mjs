const CRON_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function expandCronField(field, [minimum, maximum]) {
  const values = new Set();

  for (const part of field.split(',')) {
    const [rangeText, stepText] = part.split('/');
    const step = stepText == null ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let start;
    let end;
    if (rangeText === '*') {
      start = minimum;
      end = maximum;
    } else if (rangeText.includes('-')) {
      [start, end] = rangeText.split('-').map(Number);
    } else {
      start = Number(rangeText);
      end = start;
    }

    if (![start, end].every(Number.isInteger) || start < minimum || end > maximum || start > end) {
      return null;
    }
    for (let value = start; value <= end; value += step) values.add(value === 7 && maximum === 7 ? 0 : value);
  }

  return values;
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const weekdays = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: weekdays[parts.weekday],
  };
}

export function nextCronOccurrence(cron, after = new Date(), timeZone = 'UTC') {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const expanded = fields.map((field, index) => expandCronField(field, CRON_RANGES[index]));
  if (expanded.some(field => field == null)) return null;

  const [minutes, hours, monthDays, months, weekdays] = expanded;
  const dayWildcard = fields[2] === '*';
  const weekdayWildcard = fields[4] === '*';
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let attempt = 0; attempt < 527_040; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    const dayMatches = monthDays.has(parts.day);
    const weekdayMatches = weekdays.has(parts.weekday);
    const calendarDayMatches = dayWildcard || weekdayWildcard
      ? dayMatches && weekdayMatches
      : dayMatches || weekdayMatches;

    if (
      minutes.has(parts.minute)
      && hours.has(parts.hour)
      && months.has(parts.month)
      && calendarDayMatches
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return null;
}

export function formatScheduledRun(date, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export function executionListPath(workflowId, cursor = null) {
  const params = new URLSearchParams({workflowId, limit: '50'});
  if (cursor) params.set('cursor', cursor);
  return `/api/v1/executions?${params}`;
}

export function manualRunAvailability(executions) {
  const running = executions.find(execution => execution.status === 'running');
  if (running) {
    return {
      allowed: false,
      runningExecutionId: running.id,
      message: `Execution #${running.id} is already running.`,
    };
  }
  return {allowed: true, runningExecutionId: null, message: null};
}

export async function triggerManualRun(executions, trigger) {
  const availability = manualRunAvailability(executions);
  if (!availability.allowed) {
    return {
      accepted: false,
      runningExecutionId: availability.runningExecutionId,
      message: availability.message,
    };
  }
  await trigger();
  return {accepted: true, runningExecutionId: null, message: 'Workflow started.'};
}

export function mergeExecutionDetails(summaries, details) {
  const detailsById = new Map(details.map(execution => [execution.id, execution]));
  return summaries.map(execution => detailsById.get(execution.id) ?? execution);
}

export function mapExecution(execution) {
  const resultData = execution.data?.resultData ?? {};
  const stack = execution.data?.executionData?.nodeExecutionStack ?? [];
  const currentNodes = execution.status === 'running'
    ? [...new Set(stack.map(item => item?.node?.name).filter(Boolean))]
    : [];

  return {
    id: execution.id,
    status: execution.status,
    mode: execution.mode,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    error: execution.status === 'error' && resultData.error ? (resultData.error.message ?? 'Unknown error') : null,
    lastNode: resultData.lastNodeExecuted ?? null,
    currentNodes,
  };
}
