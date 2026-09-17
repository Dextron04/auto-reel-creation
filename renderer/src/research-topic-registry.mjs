export const TOPIC_SLUGS = Object.freeze([
  'agentic-ai',
  'editor-ide',
  'git-cli',
  'databases-performance',
  'debugging-observability',
]);

export const TOPIC_FORMATS = Object.freeze(['tips', 'trend']);

const TOPIC_POLICIES = {
  'agentic-ai': {
    slug: 'agentic-ai',
    displayName: 'Agentic AI Engineering',
    scope: 'AI agents, tool use, model context, agent runtimes, evaluation, and developer workflows for autonomous or semi-autonomous AI systems.',
    includeTerms: [
      'agentic ai', 'ai agent', 'ai agents', 'agent framework', 'agent runtime',
      'tool use', 'function calling', 'model context protocol', 'mcp server',
      'multi-agent', 'agent evaluation', 'agent memory', 'agent orchestration',
    ],
    excludeTerms: [
      'unrelated editor shortcut', 'git merge', 'database index',
      'distributed tracing only', 'consumer hardware benchmark',
    ],
    preferredDomains: [
      'modelcontextprotocol.io', 'platform.openai.com', 'docs.anthropic.com',
      'ai.google.dev', 'github.com', 'huggingface.co',
    ],
    tipsQueries: [
      'AI agent tool calling developer guide',
      'Model Context Protocol server integration tutorial',
      'agent evaluation workflow practical guide',
      'agent memory orchestration implementation',
    ],
    trendQueries: [
      'AI agent framework release notes',
      'Model Context Protocol announcement release',
      'agent tooling developer platform launch',
      'AI agent evaluation research developer news',
    ],
    minimumQualifiedSources: 5,
    minimumPrimarySources: 1,
  },
  'editor-ide': {
    slug: 'editor-ide',
    displayName: 'Editor & IDE Power Features',
    scope: 'Code editor and IDE features, extensions, shortcuts, refactoring, navigation, debugging integration, and developer productivity settings.',
    includeTerms: [
      'vscode', 'visual studio code', 'visual studio', 'jetbrains', 'intellij',
      'webstorm', 'pycharm', 'vim', 'neovim', 'editor extension', 'ide feature',
      'code completion', 'refactoring', 'editor shortcut',
    ],
    excludeTerms: [
      'agent harness', 'cloud deployment', 'database administration',
      'git hosting pricing', 'observability platform',
    ],
    preferredDomains: [
      'code.visualstudio.com', 'blog.jetbrains.com', 'neovim.io',
      'vim.org', 'learn.microsoft.com', 'github.com',
    ],
    tipsQueries: [
      'VS Code lesser known feature',
      'JetBrains productivity shortcut',
      'Neovim practical configuration tip',
      'IDE refactoring workflow developer guide',
    ],
    trendQueries: [
      'VS Code release notes new feature',
      'JetBrains IDE new feature release',
      'Neovim release announcement',
      'developer editor extension update',
    ],
    minimumQualifiedSources: 5,
    minimumPrimarySources: 1,
  },
  'git-cli': {
    slug: 'git-cli',
    displayName: 'Git & CLI Workflows',
    scope: 'Git version control and command-line workflows, branching, history, patch management, hooks, repositories, and terminal productivity.',
    includeTerms: [
      'git', 'git cli', 'git command', 'git workflow', 'git branch', 'git rebase',
      'git commit', 'git bisect', 'git worktree', 'git hook', 'command line',
      'terminal workflow', 'shell script',
    ],
    excludeTerms: [
      'editor-only shortcut', 'database query', 'agent framework',
      'distributed tracing', 'cloud console only',
    ],
    preferredDomains: [
      'git-scm.com', 'github.blog', 'docs.github.com', 'gitlab.com',
      'atlassian.com', 'ohmygit.org',
    ],
    tipsQueries: [
      'Git command line lesser known command',
      'Git worktree practical workflow',
      'Git rebase recovery guide',
      'terminal productivity command line tip',
    ],
    trendQueries: [
      'Git release notes new feature',
      'GitHub command line release announcement',
      'GitLab CLI update release',
      'developer terminal tooling release',
    ],
    minimumQualifiedSources: 5,
    minimumPrimarySources: 1,
  },
  'databases-performance': {
    slug: 'databases-performance',
    displayName: 'Databases & Performance',
    scope: 'Database engines, query planning, indexing, transactions, storage, caching, migrations, and measurable application data performance.',
    includeTerms: [
      'database', 'postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb',
      'query planner', 'query optimization', 'indexing', 'database performance',
      'sql performance', 'transaction', 'connection pool', 'database migration',
    ],
    excludeTerms: [
      'agent memory', 'editor extension', 'git branch',
      'observability-only dashboard', 'cloud pricing only',
    ],
    preferredDomains: [
      'postgresql.org', 'dev.mysql.com', 'sqlite.org', 'mongodb.com',
      'planetscale.com', 'cockroachlabs.com',
    ],
    tipsQueries: [
      'PostgreSQL query performance practical tip',
      'database indexing optimization guide',
      'SQL query planner lesser known feature',
      'connection pooling database performance guide',
    ],
    trendQueries: [
      'PostgreSQL release notes performance feature',
      'MySQL database release announcement',
      'SQLite release new performance feature',
      'database engine performance update',
    ],
    minimumQualifiedSources: 5,
    minimumPrimarySources: 1,
  },
  'debugging-observability': {
    slug: 'debugging-observability',
    displayName: 'Debugging & Observability',
    scope: 'Debugging techniques and production observability including logs, metrics, traces, profiling, instrumentation, incident diagnosis, and reliability workflows.',
    includeTerms: [
      'debugging', 'debugger', 'observability', 'opentelemetry', 'distributed tracing',
      'tracing', 'metrics', 'structured logging', 'profiling', 'instrumentation',
      'incident response', 'root cause analysis', 'telemetry',
    ],
    excludeTerms: [
      'agent orchestration', 'editor-only feature', 'git branch',
      'database index', 'marketing analytics only',
    ],
    preferredDomains: [
      'opentelemetry.io', 'prometheus.io', 'grafana.com', 'sentry.io',
      'elastic.co', 'debugger.dev',
    ],
    tipsQueries: [
      'OpenTelemetry instrumentation practical guide',
      'distributed tracing debugging technique',
      'production debugging profiling workflow',
      'structured logging observability tip',
    ],
    trendQueries: [
      'OpenTelemetry release notes new feature',
      'observability platform release announcement',
      'debugging tools developer release',
      'distributed tracing standards update',
    ],
    minimumQualifiedSources: 5,
    minimumPrimarySources: 1,
  },
};

function invalid(reason) {
  throw new Error(`RESEARCH_TOPIC_REGISTRY_INVALID:${reason}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateTopicEntry(entry, key) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`entry:${key}`);
  if (entry.slug !== key || !isNonEmptyString(entry.slug)) invalid(`slug:${key}`);
  for (const field of ['displayName', 'scope']) {
    if (!isNonEmptyString(entry[field])) invalid(`${field}:${key}`);
  }
  for (const field of ['includeTerms', 'excludeTerms', 'preferredDomains', 'tipsQueries', 'trendQueries']) {
    if (!Array.isArray(entry[field]) || entry[field].length === 0 || !entry[field].every(isNonEmptyString)) {
      invalid(`${field}:${key}`);
    }
  }
  for (const field of ['minimumQualifiedSources', 'minimumPrimarySources']) {
    if (!Number.isInteger(entry[field]) || entry[field] < 1) invalid(`${field}:${key}`);
  }
  if (entry.minimumPrimarySources > entry.minimumQualifiedSources) invalid(`thresholds:${key}`);
}

export function validateTopicRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) invalid('registry');
  const entries = Object.entries(registry);
  if (entries.length === 0) invalid('empty');
  for (const [key, entry] of entries) validateTopicEntry(entry, key);
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

validateTopicRegistry(TOPIC_POLICIES);
deepFreeze(TOPIC_POLICIES);

export function getResearchTopic(slug) {
  if (!Object.prototype.hasOwnProperty.call(TOPIC_POLICIES, slug)) {
    throw new Error(`RESEARCH_TOPIC_UNKNOWN:${slug}`);
  }
  return TOPIC_POLICIES[slug];
}
