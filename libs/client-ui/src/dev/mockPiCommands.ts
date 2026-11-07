import type { RpcSlashCommand } from '@shared/rpc'

const pkg = (name: string, file: string) => ({
  path: `/Users/dev/.pi/agent/npm/node_modules/${name}/${file}`,
  source: `npm:${name}`,
  scope: 'user' as const,
  origin: 'package' as const,
  baseDir: `/Users/dev/.pi/agent/npm/node_modules/${name}`,
})

/**
 * Shaped like a real pi answer: skills are `skill:<name>`, every entry carries
 * `sourceInfo`, and pi's own `/mcp` and `/llama` are built in — so the menu's
 * grouping and origin labels are exercised in the browser harness. This Mac's
 * `pi:commands` and a Host's `hosts:commands` answer with the same list.
 */
export const MOCK_PI_COMMANDS: RpcSlashCommand[] = [
  {
    name: 'websearch',
    description: 'Open web search curator',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  {
    name: 'mcp',
    description: 'Manage MCP servers: sign in, reconnect, enable or disable, and change exposure',
    source: 'extension',
    sourceInfo: { path: 'builtin:mcp', source: 'builtin', scope: 'temporary', origin: 'top-level' },
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
    name: 'plan',
    description: 'Draft an implementation plan',
    source: 'prompt',
    sourceInfo: {
      path: '/Users/dev/.pi/agent/prompts/plan.md',
      source: 'local',
      scope: 'user',
      origin: 'top-level',
    },
  },
  {
    name: 'skill:review',
    description: 'Review the working tree and report what would block a merge.',
    source: 'skill',
    sourceInfo: {
      path: '/mock/workspace/.claude/skills/review/SKILL.md',
      source: 'local',
      scope: 'project',
      origin: 'top-level',
    },
  },
]
