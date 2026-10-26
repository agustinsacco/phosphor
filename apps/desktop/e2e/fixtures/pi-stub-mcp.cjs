'use strict'
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const marker = (name) => path.join(agentDir(), `stub-mcp-auth-${name}`)

function servers() {
  const reports = new Map()
  for (const [scope, file] of [
    ['global', path.join(agentDir(), 'mcp.json')],
    ['project', path.join(process.cwd(), '.pi', 'mcp.json')],
  ]) {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const [name, config] of Object.entries(doc.mcpServers ?? {})) {
      const enabled = config.enabled !== false
      const state = !enabled
        ? 'disabled'
        : config.url && !config.headers?.Authorization && !fs.existsSync(marker(name))
          ? 'needs-auth'
          : 'connected'
      reports.set(name, {
        name,
        scope,
        source: file,
        enabled,
        exposure: config.exposure ?? 'codemode',
        transport: config.url ?? [config.command, ...(config.args ?? [])].join(' '),
        state,
        tools: state === 'connected' ? ['search', 'get_issue', 'save_issue'] : [],
      })
    }
  }
  return [...reports.values()]
}
function inspection(name) {
  const server = servers().find((item) => item.name === name)
  return {
    name,
    state: server?.state ?? 'failed',
    tools: (server?.tools ?? []).map((tool) => ({
      name: tool,
      description:
        tool === 'search' ? 'Find incidents and on-call responders.' : `Details for ${tool}.`,
      exposure: server.exposure,
    })),
  }
}
function runMcpCli(argv) {
  const action = argv[1]
  const name = argv[2]
  if (action === 'inspect') {
    const emit = () => {
      console.log(JSON.stringify({ version: 1, server: inspection(name) }))
      process.exit(0)
    }
    if (name === 'slow' && process.env.PHOSPHOR_E2E_MCP_DELAY)
      setTimeout(emit, Number(process.env.PHOSPHOR_E2E_MCP_DELAY))
    else emit()
    return
  }
  if (action === 'list') {
    const reports = servers()
    console.log(JSON.stringify({ servers: reports, errors: [] }))
    process.exit(
      reports.every((server) => ['connected', 'disabled'].includes(server.state)) ? 0 : 1,
    )
  }
  if (action === 'login' && name) {
    process.stdout.write(
      `Opening the browser to sign in to ${name}:\nhttps://stub.test/oauth/authorize?server=${name}\n`,
    )
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(agentDir(), `stub-mcp-approve-${name}`))) return
      clearInterval(timer)
      fs.writeFileSync(marker(name), 'ok')
      console.log(`Signed in to ${name}.`)
      process.exit(0)
    }, 100)
    return
  }
  if (action === 'logout' && name) {
    fs.rmSync(marker(name), { force: true })
    console.log(`Signed out of ${name}.`)
    process.exit(0)
  }
  console.error(`stub: unsupported pi mcp ${argv.slice(1).join(' ')}`)
  process.exit(2)
}
function handleMcpControl(cmd, out, busy) {
  if (!/^\/mcp (inspect|reconnect) .* --json --request /.test(cmd.message ?? '')) return false
  const parts = cmd.message.split(' ')
  const name = parts[2]
  const operation = parts[1]
  const requestId = parts[parts.indexOf('--request') + 1]
  const server =
    busy && operation === 'reconnect'
      ? { name, state: 'failed', tools: [], error: { code: 'busy', message: 'Lane is busy.' } }
      : inspection(name)
  out({
    type: 'extension_ui_request',
    id: requestId,
    method: 'setStatus',
    statusKey: 'mcp-inspection',
    statusText: JSON.stringify({ version: 1, requestId, operation, server }),
  })
  out({
    id: cmd.id,
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'handled' },
  })
  return true
}
module.exports = { runMcpCli, handleMcpControl }
