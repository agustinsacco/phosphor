'use strict'
const { randomUUID } = require('node:crypto')
const { dirname, join } = require('node:path')

// Only the model and pi's extension API are fixtures. The Phosphor tool, its
// editor/confirm handshake, Swarm policy, and application of effects are real.
function extension(out) {
  const load = require('jiti').createJiti(__filename, {
    fsCache: false,
    // A disposable Host build can copy its extensions outside the checkout.
    alias: { typebox: require.resolve('typebox') },
  })
  const toolPath = process.argv.find(
    (arg, i) => process.argv[i - 1] === '-e' && arg.endsWith('/phosphor.ts'),
  )
  if (!toolPath) throw new Error('The owner did not load the phosphor extension.')
  const dir = dirname(toolPath)
  const session = `stub-${process.pid}`
  const branch = []
  const pending = new Map()
  let tool, command
  const api = {
    on() {},
    registerTool(definition) {
      tool = definition
    },
    registerCommand(_name, definition) {
      command = definition
    },
    getActiveTools: () => ['subagent'],
    getAllTools: () => [{ name: 'subagent' }],
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
  }
  function emit(method, fields, id = randomUUID()) {
    out({ type: 'extension_ui_request', id, method, ...fields })
  }
  function ask(method, fields) {
    const id = randomUUID()
    return new Promise((resolve) => {
      pending.set(id, resolve)
      emit(method, fields, id)
    })
  }
  const ctx = {
    sessionManager: { getSessionId: () => session, getBranch: () => branch },
    isIdle: () => true,
    ui: {
      editor: async (title, prefill) => (await ask('editor', { title, prefill })).value,
      confirm: async (title, message, { timeout }) =>
        (await ask('confirm', { title, message, timeout })).confirmed,
      notify: (message, notifyType = 'info') => emit('notify', { message, notifyType }),
      setStatus: (statusKey, statusText) => emit('setStatus', { statusKey, statusText }),
    },
  }
  const swarm = load(join(dir, 'swarm.ts')).default(api)
  load(join(dir, 'lane-controls.ts')).registerLaneControl(session, 'swarm', swarm.control)
  load(toolPath).default(api)
  if (!tool) throw new Error('The lane is missing its owner marker.')
  return {
    tool: (params) => tool.execute(randomUUID(), params, undefined, undefined, ctx),
    userSwarm: (args) => command.handler(args, ctx),
    answer(cmd) {
      const resolve = pending.get(cmd.id)
      if (!resolve) return false
      pending.delete(cmd.id)
      resolve(cmd)
      return true
    },
  }
}

let ext
let held = false
function handle(cmd, { out, persist, models, selectModel }) {
  if (cmd.type === 'extension_ui_response') return ext?.answer(cmd)
  const reply = (data) =>
    out({ id: cmd.id, type: 'response', command: cmd.type, success: true, data })
  if (cmd.type === 'set_model') {
    const model = models.find((m) => m.id === cmd.modelId && m.provider === cmd.provider)
    if (!model) return false
    selectModel(model)
    reply(model)
    return true
  }
  if (cmd.type !== 'prompt') return false
  const message = String(cmd.message).split('\n').at(-1)
  if (held && message === '/stub-op-settle') {
    held = false
    reply({ disposition: 'handled' })
    out({ type: 'agent_settled', aborted: false })
    return true
  }
  if (ext && /^\/phosphor-swarm (on|off)$/.test(message)) {
    ext
      .userSwarm(message.split(' ')[1])
      .then(() => reply({ disposition: 'handled' }))
      .catch(fatal)
    return true
  }
  if (!message.startsWith('Test op: ')) return false
  const params = JSON.parse(message.slice('Test op: '.length))
  reply({ disposition: 'started' })
  out({ type: 'agent_start' })
  async function turn() {
    ext ??= extension(out)
    const result = await ext.tool(params)
    const response = {
      role: 'assistant',
      content: [{ type: 'text', text: result.content[0].text }],
      timestamp: Date.now(),
      stopReason: 'stop',
    }
    out({ type: 'message_start', message: { role: 'assistant', content: [] } })
    persist(response)
    out({ type: 'message_end', message: response })
    out({ type: 'agent_end', messages: [response] })
    held = params.args[0] === 'model.set'
    if (!held) out({ type: 'agent_settled', aborted: false })
  }
  turn().catch(fatal)
  return true
}
function fatal(error) {
  console.error(error)
  process.exit(1)
}
module.exports = { handle }
