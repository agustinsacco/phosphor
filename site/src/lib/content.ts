/** Shared destinations and provider connection paths. See docs/site-design.md
 * for the product-claim contract; don't turn catalogue size into marketing copy. */
export const GITHUB = 'https://github.com/agustinsacco/Phosphor'
export const RELEASES = `${GITHUB}/releases`
export const LATEST = `${RELEASES}/latest`
export const INSTALL_SH = `${LATEST}/download/install.sh`
export const PI_NPM = 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent'
export const PI_CLAUDE_CLI = 'https://github.com/agustinsacco/pi-claude-cli'

export const providers = [
  { name: 'ChatGPT · Codex', how: 'ChatGPT Plus / Pro sign-in' },
  { name: 'Claude Pro / Max', how: 'Claude Code provider package + official CLI' },
  { name: 'GitHub Copilot', how: 'Copilot subscription sign-in' },
  { name: 'Kimi For Coding', how: 'Kimi plan sign-in' },
  { name: 'Anthropic', how: 'API key' },
  { name: 'OpenAI', how: 'API key' },
  { name: 'Google Gemini', how: 'API key' },
  { name: 'Google Vertex', how: 'GCP credentials' },
  { name: 'Azure OpenAI', how: 'API key' },
  { name: 'Amazon Bedrock', how: 'AWS credentials' },
  { name: 'Mistral', how: 'API key' },
  { name: 'Groq', how: 'API key' },
  { name: 'Cerebras', how: 'API key' },
  { name: 'xAI', how: 'Sign-in, billed per token' },
  { name: 'OpenRouter', how: 'Sign-in, billed per token' },
  { name: 'Cloudflare AI Gateway', how: 'Gateway' },
  { name: 'Vercel AI Gateway', how: 'Gateway' },
  { name: 'Local endpoints', how: 'OpenAI-compatible server configuration' },
]
