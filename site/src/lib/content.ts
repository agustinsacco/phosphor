/**
 * Copy and data for the landing page. Every claim here is checked against the
 * repo's docs (docs/*.md, README.md) — if a feature changes, this file is part
 * of the same diff.
 */

export const GITHUB = 'https://github.com/agustinsacco/Phosphor'
export const RELEASES = `${GITHUB}/releases`
export const LATEST = `${GITHUB}/releases/latest`
export const INSTALL_SH = `${GITHUB}/releases/latest/download/install.sh`
export const PI_NPM = 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent'
export const PI_CLAUDE_CLI = 'https://github.com/agustinsacco/pi-claude-cli'

export interface Provider {
  name: string
  mono: string
  how: string
  kind: 'plan' | 'key' | 'gateway' | 'local'
}

/** Everything pi speaks, plus the Claude subscription bridge. */
export const providers: Provider[] = [
  { name: 'ChatGPT · Codex', mono: 'GP', how: 'ChatGPT Plus / Pro sign-in', kind: 'plan' },
  { name: 'Claude Pro / Max', mono: 'CL', how: 'via Claude Code, no API key', kind: 'plan' },
  { name: 'GitHub Copilot', mono: 'GH', how: 'Copilot subscription sign-in', kind: 'plan' },
  { name: 'Kimi For Coding', mono: 'KI', how: 'Kimi plan sign-in', kind: 'plan' },
  { name: 'Anthropic', mono: 'AN', how: 'API key', kind: 'key' },
  { name: 'OpenAI', mono: 'OA', how: 'API key', kind: 'key' },
  { name: 'Google Gemini', mono: 'GE', how: 'API key', kind: 'key' },
  { name: 'Google Vertex', mono: 'VX', how: 'GCP credentials', kind: 'key' },
  { name: 'Azure OpenAI', mono: 'AZ', how: 'API key', kind: 'key' },
  { name: 'Amazon Bedrock', mono: 'BR', how: 'AWS credentials', kind: 'key' },
  { name: 'Mistral', mono: 'MI', how: 'API key', kind: 'key' },
  { name: 'Groq', mono: 'GQ', how: 'API key', kind: 'key' },
  { name: 'Cerebras', mono: 'CB', how: 'API key', kind: 'key' },
  { name: 'xAI', mono: 'XA', how: 'sign-in, billed per token', kind: 'key' },
  { name: 'OpenRouter', mono: 'OR', how: 'sign-in, billed per token', kind: 'gateway' },
  { name: 'Cloudflare AI Gateway', mono: 'CF', how: 'gateway', kind: 'gateway' },
  { name: 'Vercel AI Gateway', mono: 'VC', how: 'gateway', kind: 'gateway' },
  { name: 'Local endpoints', mono: 'LO', how: 'any OpenAI-compatible server', kind: 'local' },
]

export const connectors = [
  { name: 'Linear', blurb: 'Issues, projects, cycles and comments.' },
  { name: 'Notion', blurb: 'Pages and databases you can already access.' },
  { name: 'Braintrust', blurb: 'Projects, experiments, datasets and logs.' },
  { name: 'Datadog', blurb: 'Logs, metrics, traces, monitors and incidents.' },
  { name: 'Supabase', blurb: 'Projects and SQL, read-only by default.' },
  { name: 'Questrade', blurb: 'Brokerage data, read scopes only — never orders.' },
  { name: 'Fellow', blurb: 'Meeting recaps, transcripts and action items.' },
  { name: 'Slack', blurb: 'Channels and messages through your own Slack app.' },
]

export const bundledExtensions = [
  {
    name: 'artifacts',
    what: 'Registers artifact_create / edit / update / read / list — versioned documents in a side panel.',
  },
  {
    name: 'context-breakdown',
    what: 'Measures what the window is full of: messages, system prompt, tool schemas, MCP schemas per server.',
  },
  {
    name: 'headroom',
    what: 'Compresses large JSON tool results through a local Headroom proxy the moment they are produced.',
  },
  {
    name: 'mcp-status',
    what: 'Forwards the MCP adapter’s per-server state (connected, needs auth, failed) to the UI.',
  },
  {
    name: 'tool-name-guard',
    what: 'Rewrites a malformed tool call before pi persists it — the one that used to brick a thread forever.',
  },
  {
    name: 'worktree-paths',
    what: 'Refuses a file read that escaped a worktree into the main checkout on a different branch.',
  },
]

export const settingsTabs = [
  'Appearance',
  'Agent',
  'Accounts',
  'Extensions',
  'MCP Connectors',
  'Workspaces',
  'Optimization',
  'Advanced',
  'Keybindings',
  'About',
]

export const laneColumns = [
  { name: 'Waiting on you', from: 'a dialog or approval an extension raised' },
  { name: 'Ready to merge', from: 'open PR, checks green, not rejected' },
  { name: 'Needs a push', from: 'failing checks, changes requested, or behind main' },
  { name: 'In review', from: 'checks still running, or a draft' },
  { name: 'Running', from: 'the agent is streaming right now' },
]

export const prChipStates = [
  { label: '#412', tone: 'success', meaning: 'open, checks green' },
  { label: '#412 ✓✓', tone: 'success', meaning: 'approved by a human' },
  { label: '#412', tone: 'danger', meaning: 'checks failing' },
  { label: '#412 ⚠', tone: 'danger', meaning: 'merge conflict' },
  { label: '#412', tone: 'merged', meaning: 'merged — this lane is done' },
  { label: '↑ no PR', tone: 'muted', meaning: 'a worktree lane with nothing open yet' },
]

export const installLines = [
  '$ npm install -g @earendil-works/pi-coding-agent',
  'added 1 package in 4s',
  '$ curl -fsSL https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh | sh',
  '==> Detected macOS arm64',
  '==> Downloading Phosphor-0.1.240-arm64.dmg',
  '==> Verified checksum',
  '==> Installed /Applications/Phosphor.app',
]
