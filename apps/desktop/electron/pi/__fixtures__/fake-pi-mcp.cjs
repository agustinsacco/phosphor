#!/usr/bin/env node
/**
 * Stands in for `pi mcp …` in `mcp-cli.test.ts`. The scenario rides on the
 * server name, so one fixture covers every outcome a test needs.
 */
const [, , sub, command, name] = process.argv
if (sub !== 'mcp') process.exit(2)

if (command === 'list') {
  process.stdout.write(
    JSON.stringify(
      {
        servers: [
          {
            name: 'up',
            scope: 'global',
            source: '/a/mcp.json',
            enabled: true,
            exposure: 'codemode',
            transport: 'https://up.test/mcp',
            state: 'connected',
            tools: ['a', 'b', 7],
          },
          {
            name: 'locked',
            scope: 'global',
            source: '/a/mcp.json',
            enabled: true,
            exposure: 'direct',
            transport: 'https://l.test/mcp',
            state: 'needs-auth',
            tools: [],
          },
          { name: 'odd', state: 'exploded', tools: 'nope' },
          { state: 'connected' },
        ],
        errors: ['/a/mcp.json: server "x y" is bad'],
        note: 'project ignored',
      },
      null,
      2,
    ) + '\n',
  )
  process.exit(1)
}

if (command === 'logout') {
  console.log(`Signed out of MCP server "${name}".`)
  process.exit(0)
}

if (command === 'login') {
  if (name === 'broken') {
    console.error(`MCP server "${name}" failed to connect: ECONNREFUSED`)
    process.exit(1)
  }
  console.log(
    `Sign in to MCP server "${name}" in your browser:\nhttps://auth.test/authorize?server=${name}`,
  )
  // A TTY stdin would mean pi asks for a pasted URL; Phosphor must never give it one.
  if (process.stdin.isTTY) process.exit(3)
  if (name === 'slow') setInterval(() => {}, 1000)
  else
    setTimeout(() => {
      console.log(`Signed in to MCP server "${name}" (3 tools).`)
      process.exit(0)
    }, 50)
}
