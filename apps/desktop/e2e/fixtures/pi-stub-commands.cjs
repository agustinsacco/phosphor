'use strict'
// Shared command catalogue for the deterministic native pi stub.
const pkg = (name, file) => ({
  path: `/stub/npm/node_modules/${name}/${file}`,
  source: `npm:${name}`,
  scope: 'user',
  origin: 'package',
  baseDir: `/stub/npm/node_modules/${name}`,
})
const prompt = (name) => ({
  path: `/stub/agent/prompts/${name}.md`,
  source: 'local',
  scope: 'user',
  origin: 'top-level',
})

module.exports = [
  {
    name: 'phosphor-swarm',
    description: 'Toggle lane authorization',
    source: 'extension',
  },
  {
    name: 'subagents-stop',
    description: 'Stop a current-session async run',
    source: 'extension',
  },
  {
    name: 'subagents-steer',
    description: 'Steer an owned async run',
    source: 'extension',
  },
  {
    name: 'phosphor-save-subagent-snapshot',
    description: 'Save an inspection snapshot',
    source: 'extension',
  },
  {
    name: 'subagents-inspect-rpc',
    description: 'Read-only child inspection',
    source: 'extension',
  },
  {
    name: 'stub-command',
    description: 'A stub command',
    source: 'extension',
    sourceInfo: {
      path: '/stub/agent/extensions/stub.ts',
      source: 'local',
      scope: 'user',
      origin: 'top-level',
    },
  },
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
    name: 'search',
    description: 'Browse stored web search results',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  // pi's built-in MCP registers one command; its source is `builtin`.
  {
    name: 'mcp',
    // Stock pi (PHOSPHOR_E2E_STOCK_PI_MCP, as in 1.4.0) lacks the inspection marker.
    description: `Manage MCP servers: sign in, reconnect, enable or disable, and change exposure${
      process.env.PHOSPHOR_E2E_STOCK_PI_MCP ? '' : ' [inspection-v1]'
    }`,
    source: 'extension',
    sourceInfo: {
      path: 'builtin:mcp',
      source: 'builtin',
      scope: 'temporary',
      origin: 'top-level',
    },
  },
  // One handler under two names, which the menu folds into one row.
  {
    name: 'web-status',
    description: 'Show web access status',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
  },
  {
    name: 'ws',
    description: 'Show web access status',
    source: 'extension',
    sourceInfo: pkg('pi-web-access', 'index.ts'),
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
    name: 'plan',
    description: 'Draft an implementation plan',
    source: 'prompt',
    sourceInfo: prompt('plan'),
  },
  {
    name: 'fix-tests',
    description: 'Fix the failing tests',
    source: 'prompt',
    sourceInfo: prompt('fix-tests'),
  },
  {
    name: 'review',
    description: 'Review the working tree',
    source: 'prompt',
    sourceInfo: prompt('review'),
  },
  {
    name: 'release-notes',
    description: 'Draft release notes from the git log',
    source: 'prompt',
    sourceInfo: prompt('release-notes'),
  },
]
