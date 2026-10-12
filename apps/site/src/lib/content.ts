import type { ImageMetadata } from 'astro'
import changes from '../assets/shots/changes.webp'
import home from '../assets/shots/home.webp'
import chat from '../assets/shots/chat.webp'
import ideFlex from '../assets/shots/ide-flex.png'
import artifacts from '../assets/shots/artifacts.webp'
import files from '../assets/shots/files.webp'
import filesLeft from '../assets/shots/files-left.webp'
import filesFull from '../assets/shots/files-full.webp'
import models from '../assets/shots/models.webp'
import modelsPicker from '../assets/shots/models-picker.webp'
import contextMeter from '../assets/shots/context-meter.webp'
import subagents from '../assets/shots/subagents.webp'
import guideClaude from '../assets/shots/guide-claude.webp'
import guideRouting from '../assets/shots/guide-routing.webp'
import guideExtensions from '../assets/shots/guide-extensions.webp'
import guideConnectors from '../assets/shots/guide-connectors.webp'

export const repo = 'https://github.com/agustinsacco/Phosphor'
export const releases = `${repo}/releases`
export const doc = (path: string) => `${repo}/blob/main/docs/${path}`
/** pi's own documentation, for anything pi owns: packages, extensions, providers. */
export const piDoc = (page: string) => `https://pi.dev/docs/latest/${page}`

// Publish only reviewed assets used by these pages. A glob would also emit
// unused historical account/settings originals into the public build.
const captures: Record<string, ImageMetadata> = {
  changes,
  home,
  chat,
  'ide-flex': ideFlex,
  artifacts,
  files,
  models,
  'models-picker': modelsPicker,
  'context-meter': contextMeter,
  subagents,
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
  { name: 'ChatGPT', plan: 'Plus / Pro', route: 'Sign in with pi’s built-in Codex login.' },
  {
    name: 'Claude',
    plan: 'Pro / Max',
    route: 'Runs through the official Claude Code CLI with a pi provider package.',
  },
  {
    name: 'GitHub Copilot',
    plan: 'Copilot subscription',
    route: 'Sign in through pi. For Enterprise Server, use pi’s terminal login.',
  },
  { name: 'Kimi', plan: 'Kimi For Coding', route: 'Sign in with your coding plan through pi.' },
]

export const packages = [
  {
    id: 'claude',
    name: 'Claude Code provider',
    spec: 'npm:@saccolabs/pi-claude-cli',
    benefit: 'Use your Claude Pro or Max plan, across as many Claude accounts as you have.',
    recommended: 'Recommended for Claude Pro and Max',
    url: 'https://github.com/agustinsacco/pi-claude-cli',
  },
  {
    id: 'mcp',
    name: 'MCP adapter',
    spec: 'npm:pi-mcp-adapter',
    benefit: 'Connect Linear, Notion, Slack, and other MCP servers.',
    url: 'https://github.com/nicobailon/pi-mcp-adapter',
  },
  {
    id: 'web',
    name: 'Web access',
    spec: 'npm:pi-web-access',
    benefit: 'Search the web, fetch pages, and read PDFs.',
    url: 'https://github.com/nicobailon/pi-web-access',
  },
  {
    id: 'subagents',
    name: 'Subagents',
    spec: 'npm:pi-subagents',
    benefit: 'Hand side tasks to separate agents with their own context.',
    url: 'https://github.com/nicobailon/pi-subagents',
  },
  {
    id: 'computer',
    name: 'Computer use',
    spec: 'npm:@injaneity/pi-computer-use',
    benefit: 'Let the agent see and click around desktop apps.',
    url: 'https://github.com/injaneity/pi-computer-use',
  },
]

export const connectors = [
  {
    id: 'linear',
    name: 'Linear',
    docs: 'https://linear.app/docs/mcp',
    use: 'Issues and projects',
    note: 'Pick the workspace you want the agent in, and check the scopes before you approve.',
  },
  {
    id: 'notion',
    name: 'Notion',
    docs: 'https://developers.notion.com/guides/mcp/overview',
    use: 'Docs and wikis',
    note: 'Share only the pages the agent needs. You don’t have to grant the whole workspace.',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    docs: 'https://www.braintrust.dev/docs/integrations/developer-tools/mcp',
    use: 'Evals and traces',
    note: 'Pick your org’s US or EU data plane. Use OAuth or an API key scoped to the projects you need. Traces can contain sensitive inputs.',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    docs: 'https://docs.datadoghq.com/mcp_server/setup/',
    use: 'Logs and metrics',
    note: 'Set the Datadog site your org uses before adding the connector.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    use: 'Database and project tools',
    note: 'The catalog entry is read-only by default. Pin it to one project if you can. Without a project ref, it can reach every project your account can.',
  },
  {
    id: 'questrade',
    name: 'Questrade',
    docs: 'https://www.questrade.com/learning/using-questrade/connect-questrade-to-your-ai-tool',
    use: 'Read-only account data',
    note: 'The catalog entry only asks for read scopes. It’s still your financial data, even with trading off.',
  },
  {
    id: 'fellow',
    name: 'Fellow',
    docs: 'https://help.fellow.ai/en/articles/12622641-fellow-s-mcp-server',
    use: 'Meeting notes',
    note: 'A workspace admin has to turn on Security → Allow users to create MCP connections first. Only send meeting content to providers you trust.',
  },
  {
    id: 'slack',
    name: 'Slack',
    docs: 'https://docs.slack.dev/ai/slack-mcp-server',
    use: 'Channels and threads',
    note: 'Needs your own registered Slack app with a client ID, PKCE, and the right user scopes. A normal Slack login isn’t enough. Follow “Set up the app” on the connector card.',
  },
]

export const guides = [
  {
    href: '/guides/',
    title: 'Install and start',
    blurb: 'Install pi and Phosphor, sign in, and run a first task.',
  },
  {
    href: '/guides/daily-work/',
    title: 'Daily work',
    blurb: 'Lanes, review and merge, panes, artifacts, routines, and skills.',
  },
  {
    href: '/guides/accounts/',
    title: 'Subscriptions and accounts',
    blurb: 'Sign in to several plans and keep going when one runs out.',
  },
  {
    href: '/guides/extensions/',
    title: 'Extensions',
    blurb: 'What’s built in, what to install, and how pi packages load.',
  },
  {
    href: '/guides/connectors/',
    title: 'MCP connectors',
    blurb: 'Connect services, sign in, test them, and add custom servers.',
  },
]
