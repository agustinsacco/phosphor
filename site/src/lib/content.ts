import type { ImageMetadata } from 'astro'
import changes from '../assets/shots/changes.webp'
import home from '../assets/shots/home.webp'
import artifacts from '../assets/shots/artifacts.webp'
import files from '../assets/shots/files.webp'
import filesLeft from '../assets/shots/files-left.webp'
import filesFull from '../assets/shots/files-full.webp'
import models from '../assets/shots/models.webp'
import guideClaude from '../assets/shots/guide-claude.webp'
import guideRouting from '../assets/shots/guide-routing.webp'
import guideExtensions from '../assets/shots/guide-extensions.webp'
import guideConnectors from '../assets/shots/guide-connectors.webp'

export const repo = 'https://github.com/agustinsacco/Phosphor'
export const releases = `${repo}/releases`
export const doc = (path: string) => `${repo}/blob/main/docs/${path}`

// Publish only reviewed assets used by these pages. A glob would also emit
// unused historical account/settings originals into the public build.
const captures: Record<string, ImageMetadata> = {
  changes,
  home,
  artifacts,
  files,
  models,
  'files-left': filesLeft,
  'files-full': filesFull,
  'guide-claude': guideClaude,
  'guide-routing': guideRouting,
  'guide-extensions': guideExtensions,
  'guide-connectors': guideConnectors,
}
export function shot(name: string): ImageMetadata {
  const capture = captures[name]
  if (!capture) throw new Error(`Missing capture: ${name}`)
  return capture
}

export const subscriptions = [
  { name: 'ChatGPT', plan: 'Plus / Pro', route: 'Sign in through pi’s native Codex OAuth.' },
  {
    name: 'Claude',
    plan: 'Pro / Max',
    route: 'Use the official Claude Code CLI through a pi provider package.',
  },
  {
    name: 'GitHub Copilot',
    plan: 'Copilot subscription',
    route: 'Sign in through pi. Enterprise Server uses pi’s terminal login.',
  },
  { name: 'Kimi', plan: 'Kimi For Coding', route: 'Sign in with your coding plan through pi.' },
]

export const packages = [
  {
    id: 'claude',
    name: 'Claude Code provider',
    spec: 'npm:@saccolabs/pi-claude-cli',
    benefit: 'Bring your Claude subscription into pi sessions.',
    url: 'https://github.com/agustinsacco/pi-claude-cli',
  },
  {
    id: 'mcp',
    name: 'MCP adapter',
    spec: 'npm:pi-mcp-adapter',
    benefit: 'Let the agent use your connected services.',
    url: 'https://github.com/nicobailon/pi-mcp-adapter',
  },
  {
    id: 'web',
    name: 'Web access',
    spec: 'npm:pi-web-access',
    benefit: 'Research the web, fetch pages, and read PDFs.',
    url: 'https://github.com/nicobailon/pi-web-access',
  },
  {
    id: 'subagents',
    name: 'Subagents',
    spec: 'npm:pi-subagents',
    benefit: 'Delegate bounded tasks to separate pi contexts.',
    url: 'https://github.com/nicobailon/pi-subagents',
  },
  {
    id: 'computer',
    name: 'Computer use',
    spec: 'npm:@injaneity/pi-computer-use',
    benefit: 'Inspect and interact with desktop interfaces.',
    url: 'https://github.com/injaneity/pi-computer-use',
  },
]

export const connectors = [
  {
    id: 'linear',
    name: 'Linear',
    docs: 'https://linear.app/docs/mcp',
    use: 'Issues and project context',
    note: 'Authorize the workspace you want the agent to access. Review granted scopes before approving.',
  },
  {
    id: 'notion',
    name: 'Notion',
    docs: 'https://developers.notion.com/guides/mcp/overview',
    use: 'Documents and knowledge',
    note: 'Authorize access to the Notion content needed for the task, not every page by default.',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    docs: 'https://www.braintrust.dev/docs/integrations/developer-tools/mcp',
    use: 'Evaluations and traces',
    note: 'Choose your organization’s US or EU data plane. Use OAuth or an API key with access to the projects you need. Traces may contain sensitive inputs.',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    docs: 'https://docs.datadoghq.com/mcp_server/setup/',
    use: 'Operational context',
    note: 'Choose the Datadog site matching your organization before adding the connector.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    use: 'Database and project tools',
    note: 'The catalog defaults to read-only. Restrict the project when possible; without a project reference the endpoint can reach multiple projects.',
  },
  {
    id: 'questrade',
    name: 'Questrade',
    docs: 'https://www.questrade.com/learning/using-questrade/connect-questrade-to-your-ai-tool',
    use: 'Read-only account data',
    note: 'The catalog pins read scopes. Financial data remains sensitive even when trading is not enabled.',
  },
  {
    id: 'fellow',
    name: 'Fellow',
    docs: 'https://help.fellow.ai/en/articles/12622641-fellow-s-mcp-server',
    use: 'Meeting context',
    note: 'A workspace admin must first enable Security → Allow users to create MCP connections. Only share meeting content with providers you trust.',
  },
  {
    id: 'slack',
    name: 'Slack',
    docs: 'https://docs.slack.dev/ai/slack-mcp-server',
    use: 'Conversation context',
    note: 'Requires a registered Slack app, a client ID, PKCE, and the required user scopes. Follow “Set up the app” in the connector card; an ordinary Slack login alone is not enough.',
  },
]

export const guides = [
  { href: '/guides/', title: 'Install and start' },
  { href: '/guides/claude-code/', title: 'Claude Code + accounts' },
  { href: '/guides/extensions/', title: 'Pi extensions' },
  { href: '/guides/connectors/', title: 'MCP connectors' },
]
