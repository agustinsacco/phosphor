const fs = require('node:fs')
const name = process.argv[4]
const report = {
  version: 1,
  server: {
    name,
    state: 'connected',
    tools: [{ name: 'search', description: 'Search incidents', exposure: 'codemode' }],
  },
}
if (process.env.MCP_TEST_MARKER) fs.appendFileSync(process.env.MCP_TEST_MARKER, `start ${name}\n`)
const finish = () => {
  if (process.env.MCP_TEST_MARKER) fs.appendFileSync(process.env.MCP_TEST_MARKER, `end ${name}\n`)
}
if (name === 'old') {
  console.error('Unknown mcp command "inspect". secret-value')
  process.exitCode = 1
} else if (name === 'malformed') {
  console.log('{"version":1,"server":null}')
} else if (name === 'hang') {
  setInterval(() => {}, 1000)
} else if (name === 'unicode') {
  report.server.tools[0].description = 'Réparer incidents'
  const bytes = Buffer.from(JSON.stringify(report) + '\n')
  const split = bytes.indexOf(Buffer.from('é')) + 1
  process.stdout.write(bytes.subarray(0, split))
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 20)
  setTimeout(finish, 150)
} else {
  console.log(JSON.stringify(report))
  setTimeout(finish, 150)
}
