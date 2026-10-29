#!/usr/bin/env node
/**
 * Stands in for stock pi (1.4.0) in `mcp-inspection.test.ts`: `pi mcp inspect`
 * does not exist there, and `pi mcp list --json` is the only connector report.
 * Each command appends its name to MCP_TEST_MARKER so a test can count runs.
 */
const fs = require('node:fs')
const [, , sub, command] = process.argv
if (sub !== 'mcp') process.exit(2)
if (process.env.MCP_TEST_MARKER) fs.appendFileSync(process.env.MCP_TEST_MARKER, `${command}\n`)

if (command === 'inspect') {
  console.error('Unknown mcp command "inspect".\nUse "pi mcp --help" for usage.')
  process.exit(1)
}
if (command === 'list') {
  const server = (name, state, exposure, tools, extra = {}) => ({
    name,
    scope: 'global',
    source: '/agent/mcp.json',
    enabled: true,
    exposure,
    transport: `https://${name}.test/mcp`,
    state,
    tools,
    ...extra,
  })
  const doc = {
    servers: [
      server('linear', 'connected', 'codemode', ['search', 'save_issue'], {
        toolExposure: { save_issue: 'direct' },
      }),
      server('datadog', 'needs-auth', 'codemode', [], { error: 'Sign in required.' }),
      server('slack', 'connected', 'deferred', ['post']),
    ],
    errors: [],
  }
  // pi exits 1 when any enabled server is not connected; the report still counts.
  setTimeout(() => {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
    process.exit(1)
  }, 200)
} else {
  process.exit(2)
}
