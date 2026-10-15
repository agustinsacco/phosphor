#!/usr/bin/env node
/**
 * The Host's fake pi: `--version`, `auth check` (ready for each provider in
 * the agent folder's auth.json, as pi 0.87.1 answers), and enough of
 * `--mode rpc` for the composition tests and accept. Like pi, it appends messages to its native session file, in the folder pi would use for its cwd, and a resumed
 * session starts with the messages of its file.
 *
 * Loaded with context-breakdown.ts (`-e`), it publishes that extension's
 * status at startup and lists phosphor-context-budget among its commands.
 * A prompt holding "stream" or "count" streams until aborted; one holding
 * "recall" answers with the last PHX-... token of the session; any other
 * answers with the first PHX-... token it holds, or "ok". "/fake-ask" asks
 * a confirm dialog and answers once the dialog is answered, printing the
 * answer on stderr as FAKE_PI_DIALOG <json>. "/fake-clone" is an extension
 * command that does what pi's clone does: copy the session to a new file and
 * move onto it, before it answers. "/fake-clone-fails" does the same, then
 * fails. "/fake-clone-hold-reply <file>" moves and holds its answer, and
 * "/fake-clone-hold-state <file>" moves, answers, and holds the next
 * get_state: each writes <file>.held once it holds, and lets go once <file>
 * exists. "/fake-clone-lose-state" moves, after which get_state fails while
 * pi runs on, as pi 0.87.1's does once the last session_info of its file has
 * a name that is not a string. "/fake-clone-hide-file" moves, after which
 * get_state names no file until "/fake-find-file". Modes, from the
 * environment pi receives:
 *   FAKE_PI_IGNORE_TERM=1  ignore SIGTERM, so only SIGKILL stops it
 *   FAKE_PI_CHILD=1        start a child in its process group that ignores SIGTERM
 *   FAKE_PI_ESCAPE=<file>  start a child in a group of its own that holds pi's stdout and stderr
 *                          open for 60 s, writing its pid to <file>: pi's pipes then outlive pi
 *   FAKE_PI_LEAK=1         print ANTHROPIC_API_KEY on stderr at startup, as a failing provider might
 *   FAKE_PI_FORGET=1       answer a recall with "ok", as a model that lost the context would
 *   FAKE_PI_STALL=<file>   stream every prompt until aborted, writing pi's pid to <file> as each starts
 *   PI_FAKE_PROVIDER=<p>   report provider <p> whatever pi was started with, as pi's default would
 *                          (a PI_ name: pi receives it unpassed, and its value is no secret)
 *   PI_FAKE_MODEL=<m>      report model <m> whatever pi was started with
 *   PI_FAKE_SILENT=<type>  never answer a command of that type, as a pi that hangs on it would
 *   FAKE_PI_TURN=wrong     answer every prompt with "ok"
 *   FAKE_PI_TURN=fail      end every turn in an error that holds ANTHROPIC_API_KEY
 *   FAKE_PI_TURN=exit      answer a prompt, then exit with code 3
 *   FAKE_PI_HIDE=status    publish no breakdown status; =budget lists no budget command
 * At startup it prints, on stderr, the names in its environment, its PATH
 * and its child's pid.
 */
'use strict'
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('1.2.0')
  process.exit(0)
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

// pi's layout, as libs/session-runtime/src/pi/pi-paths.ts mangles it: keep the two in step.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? '/', '.pi', 'agent')
if (args[0] === 'auth') {
  const provider = flag('--provider')
  let stored = {}
  try {
    stored = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))
  } catch {}
  const ready = Boolean(stored[provider])
  const reason = ready ? {} : { reason: 'credentials_not_configured' }
  console.log(JSON.stringify({ status: ready ? 'ready' : 'not_ready', provider, ...reason }))
  process.exit(ready ? 0 : 1)
}
// Print mode must consume EOF, matching real pi rather than masking open-stdin bugs.
if (args.includes('-p') || args.includes('--print')) {
  console.error('FAKE_PI_PRINT_WAITING_FOR_EOF')
  process.stdin.resume()
  process.stdin.on('end', () => {
    console.log('HOST_A_ONLY title')
    process.exit(0)
  })
  return
}
if (args.includes('--no-session') && !args.includes('--mode')) {
  console.log('HOST_A_ONLY provider login: /login <provider>, then /quit')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    const provider = /\/login ([a-z0-9-]+)/.exec(chunk)?.[1]
    if (provider) {
      let auth = {}
      try {
        auth = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))
      } catch {}
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(
        join(agentDir, 'auth.json'),
        JSON.stringify({ ...auth, [provider]: { type: 'api_key', key: 'fixture-only' } }),
      )
      console.log('HOST_A_ONLY signed in')
    }
    if (chunk.includes('/quit')) process.exit(0)
  })
  return
}
const models = [
  {
    provider: 'fake',
    id: 'fake-model',
    name: 'HOST_A_ONLY Fast',
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    provider: 'anthropic',
    id: 'host-reasoner',
    name: 'HOST_B_ONLY Reasoner',
    reasoning: true,
    contextWindow: 100000,
    maxTokens: 4096,
  },
]
const sessions = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, 'sessions')
const folder = join(
  sessions,
  `--${process
    .cwd()
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`,
)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
let sessionFile = flag('--session') ?? join(folder, `${stamp()}_${randomUUID()}.jsonl`)
let id = randomUUID()
/** The session's messages: those of a resumed file, then every turn saved. */
const messages = existsSync(sessionFile)
  ? readFileSync(sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
  : []
let lastEntryId = existsSync(sessionFile)
  ? (JSON.parse(readFileSync(sessionFile, 'utf8').trim().split('\n').at(-1)).id ?? null)
  : null
const extensions = args.flatMap((arg, at) => (arg === '-e' ? [args[at + 1]] : []))
const breakdown = extensions.some((path) => path.endsWith('/context-breakdown.ts'))

console.error(`FAKE_PI_ENV ${Object.keys(process.env).sort().join(',')}`)
console.error(`FAKE_PI_PATH ${process.env.PATH ?? ''}`)
if (process.env.FAKE_PI_LEAK) {
  console.error(`cannot reach the provider with ${process.env.ANTHROPIC_API_KEY}`)
}
if (process.env.FAKE_PI_CHILD) {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' },
  )
  console.error(`FAKE_PI_CHILD ${child.pid}`)
}
if (process.env.FAKE_PI_ESCAPE) {
  const escaped = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  writeFileSync(process.env.FAKE_PI_ESCAPE, String(escaped.pid))
  escaped.unref()
}
process.on('SIGTERM', () => {
  if (!process.env.FAKE_PI_IGNORE_TERM) process.exit(0)
})

const out = (record) => process.stdout.write(JSON.stringify(record) + '\n')
// What context-breakdown.ts publishes on session_start.
if (breakdown && process.env.FAKE_PI_HIDE !== 'status') {
  out({
    type: 'extension_ui_request',
    id: randomUUID(),
    method: 'setStatus',
    statusKey: 'phosphor-context-breakdown',
    statusText: '{"components":[]}',
  })
}
const respond = (cmd, data) =>
  out({ id: cmd.id, type: 'response', command: cmd.type, success: true, data })
const fail = (cmd, error) =>
  out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error })
const text = (value) => ({ role: 'assistant', content: [{ type: 'text', text: value }] })

const header = () =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  })

/** Native JSONL entries form one parent-linked chain, including tools and names. */
function persist(message) {
  if (!existsSync(sessionFile)) {
    mkdirSync(dirname(sessionFile), { recursive: true })
    appendFileSync(sessionFile, header() + '\n')
  }
  {
    const entryId = randomUUID()
    appendFileSync(
      sessionFile,
      JSON.stringify({ type: 'message', id: entryId, parentId: lastEntryId, message }) + '\n',
    )
    lastEntryId = entryId
    messages.push(message)
  }
}

function save(reply) {
  persist(reply)
}

/** pi's clone: a new file with this one's entries, which pi then writes instead. */
function clone() {
  const entries = existsSync(sessionFile)
    ? readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).slice(1)
    : []
  id = randomUUID()
  sessionFile = join(dirname(sessionFile), `${stamp()}_${id}.jsonl`)
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, [header(), ...entries].map((line) => line + '\n').join(''))
}

/** Run `then` once `file` exists, after writing `file`.held to say it waits. */
function holdUntil(file, then) {
  writeFileSync(`${file}.held`, '')
  const timer = setInterval(() => {
    if (!existsSync(file)) return
    clearInterval(timer)
    then()
  }, 10)
}

// The file whose existence lets the next get_state be answered, if one is held.
let heldState = null
// Each dialog asked and not yet answered: what to do with its answer.
const dialogs = new Map()
// How get_state answers once a move has made it lose its file: 'fails' or 'hides'.
let lostState = null

let streaming = null
const queued = []
function publishQueue() {
  out({
    type: 'queue_update',
    steering: queued.filter((item) => item.mode === 'steer').map((item) => item.message),
    followUp: queued.filter((item) => item.mode !== 'steer').map((item) => item.message),
  })
}
let artifactVersion = messages.reduce(
  (version, message) =>
    message.role === 'toolResult' && message.details?.id === 'host-card'
      ? Math.max(version, message.details.version ?? 0)
      : version,
  0,
)
function delta(value) {
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: value } })
}
function finish(_user, reply, stopReason, errorMessage) {
  const message = { ...text(reply), stopReason, ...(errorMessage && { errorMessage }) }
  out({ type: 'message_end', message })
  save(message)
  out({ type: 'agent_end', messages: [message] })
  out({ type: 'agent_settled', aborted: stopReason === 'aborted' })
  const next = queued.shift()
  publishQueue()
  if (next) setTimeout(() => prompt(next.message), 10)
}
function laneMarker() {
  try {
    if (readFileSync(join(process.cwd(), 'remote.txt'), 'utf8').includes('HOST_B_ONLY'))
      return 'HOST_B_ONLY'
  } catch {}
  return 'HOST_A_ONLY'
}
function artifact() {
  const version = ++artifactVersion
  const name = version === 1 ? 'artifact_create' : 'artifact_update'
  const callId = randomUUID()
  const args = {
    id: 'host-card',
    title: `${laneMarker()} card`,
    type: 'html',
    content: `<h1>${laneMarker()} version ${version}</h1>`,
  }
  const call = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name, arguments: args }],
    stopReason: 'toolUse',
  }
  out({ type: 'message_end', message: call })
  persist(call)
  out({ type: 'tool_execution_start', toolCallId: callId, toolName: name, args })
  const result = {
    content: [{ type: 'text', text: `${laneMarker()} artifact saved` }],
    details: { ...args, version },
  }
  out({ type: 'tool_execution_end', toolCallId: callId, toolName: name, isError: false, result })
  persist({ role: 'toolResult', toolCallId: callId, toolName: name, ...result, isError: false })
}
function linkTool() {
  const toolCallId = randomUUID()
  const path = join(process.cwd(), 'nested', 'guide.md')
  const args = { path, offset: 2 }
  const call = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: 'read', arguments: args }],
    stopReason: 'toolUse',
  }
  out({ type: 'message_end', message: call })
  persist(call)
  out({ type: 'tool_execution_start', toolCallId, toolName: 'read', args })
  const result = { content: [{ type: 'text', text: `${laneMarker()} guide line two` }] }
  out({ type: 'tool_execution_end', toolCallId, toolName: 'read', isError: false, result })
  persist({ role: 'toolResult', toolCallId, toolName: 'read', ...result, isError: false })
}
function prompt(message) {
  persist({ role: 'user', content: message })
  out({ type: 'agent_start' })
  out({ type: 'message_start', message: { role: 'user', content: message } })
  out({ type: 'message_end', message: { role: 'user', content: message } })
  out({ type: 'message_start', message: text('') })
  if (/artifact/i.test(message)) artifact()
  if (/links/i.test(message)) linkTool()
  if (/stream|count|slow/i.test(message) || process.env.FAKE_PI_STALL) {
    if (process.env.FAKE_PI_STALL) writeFileSync(process.env.FAKE_PI_STALL, String(process.pid))
    const releaseFile = /^slow-until (.+)$/.exec(message)?.[1]
    const deadline = Date.now() + 10000
    let count = 0
    streaming = { user: message, reply: '' }
    streaming.timer = setInterval(() => {
      const piece = `${++count} `
      streaming.reply += piece
      delta(piece)
      const released = releaseFile && existsSync(releaseFile)
      const expired = releaseFile && Date.now() >= deadline
      if (released || expired || (!releaseFile && /slow/i.test(message) && count === 12)) {
        const completed = streaming
        clearInterval(completed.timer)
        streaming = null
        finish(
          completed.user,
          completed.reply,
          expired ? 'error' : 'stop',
          expired ? 'Fixture slow turn was not released within 10 seconds' : undefined,
        )
      }
    }, 20)
    return
  }
  const tokens =
    /recall/i.test(message) && !process.env.FAKE_PI_FORGET
      ? messages.flatMap((m) => JSON.stringify(m.content).match(/PHX-[A-Za-z0-9]+/g) ?? [])
      : /PHX-[A-Za-z0-9]+/.exec(message)
  const reply = /links/i.test(message)
    ? `[${laneMarker()} guide](nested/guide.md#L2) [absolute](${join(process.cwd(), 'remote.txt')})`
    : (process.env.FAKE_PI_TURN !== 'wrong' && tokens?.at(-1)) || 'ok'
  delta(reply)
  if (process.env.FAKE_PI_TURN === 'fail' || /fail-turn/.test(message)) {
    const error = /fail-turn/.test(message)
      ? `${laneMarker()} provider error`
      : `401: invalid x-api-key ${process.env.ANTHROPIC_API_KEY}`
    return setTimeout(() => finish(message, '', 'error', error), 10)
  }
  if (process.env.FAKE_PI_TURN === 'exit') return setTimeout(() => process.exit(3), 50)
  setTimeout(() => finish(message, reply, 'stop'), 10)
}

/** What get_state reports. */
let selectedModel
let selectedThinking
let selectedName = existsSync(sessionFile)
  ? readFileSync(sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.type === 'session_info')?.name
  : undefined
function state() {
  return {
    model: selectedModel ?? {
      ...models.find((model) => model.provider === (flag('--provider') ?? 'fake')),
      // Like pi, it takes --provider only together with --model.
      provider: process.env.PI_FAKE_PROVIDER ?? (flag('--model') && flag('--provider')) ?? 'fake',
      id: process.env.PI_FAKE_MODEL ?? flag('--model') ?? 'fake-model',
      contextWindow: flag('--provider') === 'anthropic' ? 100000 : 200000,
    },
    thinkingLevel: selectedThinking ?? flag('--thinking') ?? 'off',
    isStreaming: streaming !== null,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    sessionFile,
    sessionId: id,
    sessionName: selectedName ?? flag('-n'),
    autoCompactionEnabled: true,
    messageCount: messages.length,
    pendingMessageCount: queued.length,
  }
}

function handle(cmd) {
  if (cmd.type === process.env.PI_FAKE_SILENT) return
  switch (cmd.type) {
    case 'get_state': {
      const answer = () => {
        if (lostState === 'fails') return fail(cmd, 'cannot read the session')
        return respond(cmd, {
          ...state(),
          ...(lostState === 'hides' && { sessionFile: undefined }),
        })
      }
      if (heldState === null) return answer()
      const release = heldState
      heldState = null
      return holdUntil(release, answer)
    }
    case 'prompt': {
      const space = cmd.message.indexOf(' ')
      const name = space === -1 ? cmd.message : cmd.message.slice(0, space)
      const arg = cmd.message.slice(space + 1)
      switch (name) {
        case '/fake-clone':
          clone()
          return respond(cmd)
        case '/fake-clone-fails':
          clone()
          return fail(cmd, 'the extension failed')
        case '/fake-clone-hold-reply':
          clone()
          return holdUntil(arg, () => respond(cmd))
        case '/fake-clone-hold-state':
          clone()
          heldState = arg
          return respond(cmd)
        case '/fake-clone-lose-state':
        case '/fake-clone-hide-file':
          clone()
          lostState = name === '/fake-clone-lose-state' ? 'fails' : 'hides'
          return respond(cmd)
        case '/fake-find-file':
          lostState = null
          return respond(cmd)
        case '/fake-ask': {
          const dialog = randomUUID()
          dialogs.set(dialog, (answer) => {
            console.error(`FAKE_PI_DIALOG ${JSON.stringify(answer)}`)
            respond(cmd)
          })
          return out({
            type: 'extension_ui_request',
            id: dialog,
            method: 'confirm',
            title: 'Allow?',
            message: 'The fake asks',
          })
        }
      }
      respond(cmd)
      if (cmd.message === '/host-only') {
        out({
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'notify',
          message: 'HOST_A_ONLY command handled',
          notifyType: 'info',
        })
        return
      }
      if (cmd.message.startsWith('/phosphor-context-budget ')) return
      if (streaming) {
        queued.push({ message: cmd.message, mode: cmd.streamingBehavior ?? 'followUp' })
        publishQueue()
        return
      }
      // The context-budget extension's command: no model turn.
      if (!cmd.message.startsWith('/phosphor-context-budget ')) prompt(cmd.message)
      return
    }
    case 'steer':
    case 'follow_up':
      queued.push({ message: cmd.message, mode: cmd.type === 'steer' ? 'steer' : 'followUp' })
      publishQueue()
      return respond(cmd)
    case 'abort': {
      respond(cmd)
      if (!streaming) return
      const { user, reply, timer } = streaming
      clearInterval(timer)
      streaming = null
      return finish(user, reply, 'aborted')
    }
    case 'extension_ui_response': {
      const answered = dialogs.get(cmd.id)
      dialogs.delete(cmd.id)
      const { type: _, id: __, ...answer } = cmd
      return answered?.(answer)
    }
    case 'get_commands':
      return respond(cmd, {
        commands:
          breakdown && process.env.FAKE_PI_HIDE !== 'budget'
            ? [
                { name: 'phosphor-context-budget', source: 'extension' },
                { name: 'host-only', description: 'HOST_A_ONLY command', source: 'extension' },
              ]
            : [],
      })
    case 'set_model':
      selectedModel = models.find(
        (model) => model.provider === cmd.provider && model.id === cmd.modelId,
      ) ?? { provider: cmd.provider, id: cmd.modelId, contextWindow: 200000 }
      return respond(cmd, selectedModel)
    case 'set_thinking_level':
      selectedThinking = cmd.level
      return respond(cmd)
    case 'set_session_name':
      selectedName = cmd.name
      if (!existsSync(sessionFile)) {
        mkdirSync(dirname(sessionFile), { recursive: true })
        appendFileSync(sessionFile, header() + '\n')
      }
      const entryId = randomUUID()
      appendFileSync(
        sessionFile,
        JSON.stringify({
          type: 'session_info',
          id: entryId,
          parentId: lastEntryId,
          name: cmd.name,
        }) + '\n',
      )
      lastEntryId = entryId
      return respond(cmd)
    case 'compact':
      out({ type: 'compaction_start', reason: 'manual' })
      respond(cmd, { summary: 'HOST_A_ONLY compacted', firstKeptEntryId: '', tokensBefore: 0 })
      return out({
        type: 'compaction_end',
        reason: 'manual',
        aborted: false,
        result: { summary: 'HOST_A_ONLY compacted', firstKeptEntryId: '', tokensBefore: 0 },
      })
    case 'get_available_thinking_levels':
      return respond(cmd, {
        levels: state().model.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'],
      })
    case 'get_available_models':
      return respond(cmd, { models })
    case 'get_session_stats':
      return respond(cmd, {
        sessionId: id,
        sessionFile,
        userMessages: messages.filter((m) => m.role === 'user').length,
        assistantMessages: messages.filter((m) => m.role === 'assistant').length,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: messages.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      })
    case 'get_messages':
      return respond(cmd, { messages })
    case 'get_last_assistant_text': {
      const last = messages.findLast((m) => m.role === 'assistant')
      return respond(cmd, { text: last ? last.content.map((block) => block.text).join('') : null })
    }
    case 'set_auto_retry':
      return respond(cmd, { enabled: cmd.enabled })
    default:
      fail(cmd, 'unsupported in fake')
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
// pi in RPC mode exits when its input ends.
process.stdin.on('end', () => process.exit(0))
