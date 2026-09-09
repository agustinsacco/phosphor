import type { ImageMetadata } from 'astro'

export const repo = 'https://github.com/agustinsacco/Phosphor'
export const releases = `${repo}/releases`
export const doc = (path: string) => `${repo}/blob/main/docs/${path}`

const captures = import.meta.glob<{ default: ImageMetadata }>('../assets/shots/*.{webp,png}', {
  eager: true,
})
export function shot(name: string): ImageMetadata {
  const capture =
    captures[`../assets/shots/${name}.webp`] ?? captures[`../assets/shots/${name}.png`]
  if (!capture) throw new Error(`Missing real capture: ${name}`)
  return capture.default
}

// The original 6012 × 3322 capture supplied by the user: Headroom Optimization,
// Claude Opus 5, Monaco left, results table and 35% context meter on the right.
export const ideCapture = shot('ide-flex')

export const subscriptions = [
  {
    mark: 'O',
    name: 'ChatGPT',
    plan: 'Plus or Pro',
    route: 'Sign in with pi’s native Codex OAuth provider. No Codex CLI bridge required.',
  },
  {
    mark: 'C',
    name: 'Claude',
    plan: 'Pro or Max',
    route: 'Use the Claude Code provider extension and your authenticated Claude Code CLI.',
  },
  {
    mark: 'G',
    name: 'GitHub Copilot',
    plan: 'Copilot subscription',
    route: 'Sign in through pi. Enterprise Server accounts use pi’s terminal login route.',
  },
  {
    mark: 'K',
    name: 'Kimi',
    plan: 'Kimi For Coding',
    route: 'Sign in with your Kimi For Coding plan through pi’s account login.',
  },
]

export const providers = [
  'Anthropic',
  'OpenAI',
  'Gemini',
  'Vertex AI',
  'Azure OpenAI',
  'Amazon Bedrock',
  'Mistral',
  'Groq',
  'Cerebras',
  'xAI',
  'OpenRouter',
  'Cloudflare AI Gateway',
  'Vercel AI Gateway',
  'Custom / local endpoints',
]

export const connectors = [
  'Linear',
  'Notion',
  'Braintrust',
  'Datadog',
  'Supabase',
  'Questrade',
  'Fellow',
  'Slack',
]

export const bundled = [
  ['artifacts', 'Create and revise deliverables in the side panel.'],
  ['context-breakdown', 'Estimate what occupies the context window.'],
  ['headroom', 'Optionally compress eligible tool results through a local proxy.'],
  ['mcp-status', 'Report connector state through pi’s status channel.'],
  ['tool-name-guard', 'Repair malformed tool names before they enter saved history.'],
  ['worktree-paths', 'Catch supported file-tool paths aimed at the wrong checkout.'],
]

export const featureIndex = [
  [
    'Models & subscriptions',
    'settings.md#accounts',
    'Native and package providers; OAuth or API keys; custom endpoints; model and thinking-level controls.',
  ],
  [
    'Accounts, MCP & context',
    'chat.md#what-the-context-meters-popover-shows',
    'Claude account routing and usage; estimated context composition; per-server MCP schema attribution.',
  ],
  [
    'Lanes, branches & PRs',
    'lanes.md',
    'Searchable session identity, PR/check/review state, worktrees, naming, cleanup and lost-work warnings.',
  ],
  [
    'Transcript & composer',
    'chat.md',
    'Streaming text, thinking, tool steps, rich output, file mentions, shell lines, steering and follow-ups.',
  ],
  [
    'Files & terminal',
    'files.md',
    'Explorer transfers, Monaco tabs and dirty-buffer conflicts; a separate real-shell terminal pane.',
  ],
  [
    'Artifacts & extensions',
    'extensions.md',
    'Versioned previews and diffs, sandboxed HTML, package management, tools, skills, prompts and themes.',
  ],
  [
    'Sessions & layout',
    'ui-shell.md',
    'Independent concurrent sessions, per-session pane placement, fullscreen, global skills and artifacts pages.',
  ],
  [
    'Install & updates',
    'updates.md',
    'pi on PATH, platform-specific release assets, packaged-app update checks and install-path-specific updates.',
  ],
]
