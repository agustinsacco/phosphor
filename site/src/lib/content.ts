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
    route: 'pi’s native Codex OAuth. No CLI bridge in the way.',
  },
  {
    mark: 'C',
    name: 'Claude',
    plan: 'Pro or Max',
    route: 'The Claude Code provider drives your signed-in Claude Code CLI.',
  },
  {
    mark: 'G',
    name: 'GitHub Copilot',
    plan: 'Copilot subscription',
    route: 'Sign in through pi. Enterprise Server uses pi’s terminal login.',
  },
  {
    mark: 'K',
    name: 'Kimi',
    plan: 'Kimi For Coding',
    route: 'Sign in with your Kimi For Coding plan through pi.',
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
  ['artifacts', 'Versioned deliverables in their own pane.'],
  ['context-breakdown', 'Estimates what is filling the context window.'],
  ['headroom', 'Losslessly shrinks big tool results through a local proxy. Opt-in.'],
  ['mcp-status', 'Per-server MCP state, straight from the adapter.'],
  ['tool-name-guard', 'Repairs a malformed tool name before it bricks the thread.'],
  ['worktree-paths', 'Refuses a file tool that wanders into the wrong checkout.'],
]

export const featureIndex = [
  [
    'Models & subscriptions',
    'settings.md#accounts',
    'Native and package providers. OAuth or API keys. Custom endpoints. Model and thinking controls.',
  ],
  [
    'Accounts, MCP & context',
    'chat.md#what-the-context-meters-popover-shows',
    'Claude account routing and usage. Estimated context composition. MCP cost per server.',
  ],
  [
    'Lanes, branches & PRs',
    'lanes.md',
    'One row per task: session, branch, worktree, PR state. Search, naming, cleanup, lost-work guards.',
  ],
  [
    'Transcript & composer',
    'chat.md',
    'Streaming text, thinking, tool steps, rich output, file mentions, shell lines, steering and follow-ups.',
  ],
  [
    'Files & terminal',
    'files.md',
    'Explorer transfers, Monaco tabs, dirty-buffer conflicts. A real shell beside the chat.',
  ],
  [
    'Artifacts & extensions',
    'extensions.md',
    'Versioned previews and diffs, sandboxed HTML, packages, tools, skills, prompts and themes.',
  ],
  [
    'Sessions & layout',
    'ui-shell.md',
    'Independent concurrent sessions, per-session pane placement, fullscreen, global pages.',
  ],
  [
    'Install & updates',
    'updates.md',
    'pi on PATH, per-platform release assets, update checks that match how you installed.',
  ],
]
