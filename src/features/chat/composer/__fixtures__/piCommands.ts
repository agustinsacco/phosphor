import type { RpcSlashCommand } from '@shared/rpc'

/**
 * A real `get_commands` answer, captured 2026-09-16 from pi 0.84 with
 * pi-web-access, pi-mcp-adapter, pi-computer-use and pi-claude-cli installed
 * and a Notion MCP server connected; home directory rewritten to `/home/dev`.
 *
 * Eighteen entries: eleven extension commands (including the `/mcp` +
 * `/pi-mcp` alias pair, two Notion prompt commands and pi's inline `/llama`),
 * then seven skills from four different roots. This is the payload the menu
 * capped at 12 — the shape every test here should be run against.
 */
const pkg = (name: string, file: string): RpcSlashCommand['sourceInfo'] => ({
  path: `/home/dev/.pi/agent/npm/node_modules/${name}/${file}`,
  source: `npm:${name}`,
  scope: 'user',
  origin: 'package',
  baseDir: `/home/dev/.pi/agent/npm/node_modules/${name}`,
})

export const REAL_PI_COMMANDS: RpcSlashCommand[] = [
  {
    name: 'websearch',
    description: 'Open web search curator',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  {
    name: 'curator',
    description: 'Toggle or configure the search curator workflow',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  {
    name: 'google-account',
    description: 'Show the active Google account for Gemini Web',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  {
    name: 'search',
    description: 'Browse stored web search results',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  {
    name: 'mcp__notion__make-this-a-notion-page',
    description: 'MCP: Turn the current work into a durable Notion page.',
    source: 'extension',
    sourceInfo: pkg('pi-mcp-adapter', 'index.ts'),
  },
  {
    name: 'mcp__notion__make-this-a-notion-database',
    description: 'MCP: Turn the current work into a trackable Notion database.',
    source: 'extension',
    sourceInfo: pkg('pi-mcp-adapter', 'index.ts'),
  },
  {
    name: 'mcp',
    description: 'Show MCP server status',
    source: 'extension',
    sourceInfo: pkg('pi-mcp-adapter', 'index.ts'),
  },
  {
    name: 'pi-mcp',
    description: 'Show MCP server status',
    source: 'extension',
    sourceInfo: pkg('pi-mcp-adapter', 'index.ts'),
  },
  {
    name: 'mcp-auth',
    description: 'Authenticate with an MCP server (OAuth)',
    source: 'extension',
    sourceInfo: pkg('pi-mcp-adapter', 'index.ts'),
  },
  {
    name: 'computer-use',
    description: 'Show pi-computer-use configuration',
    source: 'extension',
    sourceInfo: pkg('@injaneity/pi-computer-use', 'extensions/computer-use.ts'),
  },
  {
    name: 'llama',
    description: 'Manage llama.cpp router models',
    source: 'extension',
    sourceInfo: {
      path: '<inline:llama.cpp>',
      source: 'inline',
      scope: 'temporary',
      origin: 'top-level',
    },
  },
  {
    name: 'skill:debug',
    description:
      "Diagnose a Phosphor session that errors, hangs, or returns an empty reply — read the main-process debug log, pi's session JSONL, and the provider's own transcript. Use when a session \"isn't working\", a turn fails with a confusing message, pi crashes, or a provider (Claude CLI, Bedrock) misbehaves.",
    source: 'skill',
    sourceInfo: {
      path: '/home/dev/src/Phosphor/.claude/skills/debug/SKILL.md',
      source: 'local',
      scope: 'project',
      origin: 'top-level',
    },
  },
  {
    name: 'skill:e2e',
    description:
      'Run or extend the Playwright-Electron e2e suite (deterministic pi stub, no API key). Use when verifying IPC/session/UI flows end-to-end, debugging a failing smoke test, or adding e2e coverage for a new feature.',
    source: 'skill',
    sourceInfo: {
      path: '/home/dev/src/Phosphor/.claude/skills/e2e/SKILL.md',
      source: 'local',
      scope: 'project',
      origin: 'top-level',
    },
  },
  {
    name: 'skill:run',
    description:
      'Launch Phosphor to see a change working — Electron dev mode with a real pi, the browser-only mock harness, or a stubbed Electron instance when no pi/API key is available.',
    source: 'skill',
    sourceInfo: {
      path: '/home/dev/src/Phosphor/.claude/skills/run/SKILL.md',
      source: 'local',
      scope: 'project',
      origin: 'top-level',
    },
  },
  {
    name: 'skill:test-augie-e2e-slack',
    description:
      'Personal workflow for manually testing Augie end-to-end via Slack DM, with every reply cross-checked against its Braintrust trace.',
    source: 'skill',
    sourceInfo: {
      path: '/home/dev/.claude/skills/test-augie-e2e-slack/SKILL.md',
      source: 'local',
      scope: 'user',
      origin: 'top-level',
    },
  },
  {
    name: 'skill:game-builder',
    description:
      'End-to-end workflow for building polished, installable desktop/browser games with a deterministic engine, procedural 2.5D art, save systems and CI-gated public releases.',
    source: 'skill',
    sourceInfo: {
      path: '/home/dev/.pi/agent/skills/game-builder/SKILL.md',
      source: 'auto',
      scope: 'user',
      origin: 'top-level',
      baseDir: '/home/dev/.pi/agent',
    },
  },
  {
    name: 'skill:snowflake-mcp',
    description:
      'Write safe, scoped Snowflake SQL queries with read-only access to a production data warehouse. Enforces LIMIT 100, avoids VARIANT columns, and uses semantic views.',
    source: 'skill',
    sourceInfo: {
      path: '/home/dev/.pi/agent/skills/snowflake-mcp/SKILL.md',
      source: 'auto',
      scope: 'user',
      origin: 'top-level',
      baseDir: '/home/dev/.pi/agent',
    },
  },
  {
    name: 'skill:mcp-scripting',
    description: 'Write mcpScript JavaScript for discovering, inspecting, and calling MCP tools.',
    source: 'skill',
    sourceInfo: pkg('pi-mcp-adapter', 'skills/mcp-scripting/SKILL.md'),
  },
]
