#!/usr/bin/env node
/**
 * The Host's fake pi: `--version`, and enough of `--mode rpc` for the
 * composition tests and accept. Like pi, it saves a turn to its session file
 * when the turn ends, in the folder pi would use for its cwd, and a resumed
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
  console.log('0.87.1')
  process.exit(0)
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

// pi's layout, as libs/session-runtime/src/pi/pi-paths.ts mangles it: keep the two in step.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? '/', '.pi', 'agent')
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

/** What pi does when a turn ends: append it, writing the header first for a new file. */
function save(user, reply) {
  if (!existsSync(sessionFile)) {
    mkdirSync(dirname(sessionFile), { recursive: true })
    appendFileSync(sessionFile, header() + '\n')
  }
  for (const message of [{ role: 'user', content: user }, reply]) {
    appendFileSync(
      sessionFile,
      JSON.stringify({ type: 'message', id: randomUUID(), message }) + '\n',
    )
    messages.push(message)
  }
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
function delta(value) {
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: value } })
}
function finish(user, reply, stopReason, errorMessage) {
  const message = { ...text(reply), stopReason, ...(errorMessage && { errorMessage }) }
  out({ type: 'message_end', message })
  save(user, message)
  out({ type: 'agent_end', messages: [message] })
  out({ type: 'agent_settled' })
}
function prompt(message) {
  out({ type: 'agent_start' })
  out({ type: 'message_start', message: text('') })
  if (/stream|count/i.test(message) || process.env.FAKE_PI_STALL) {
    if (process.env.FAKE_PI_STALL) writeFileSync(process.env.FAKE_PI_STALL, String(process.pid))
    let count = 0
    streaming = { user: message, reply: '' }
    streaming.timer = setInterval(() => {
      const piece = `${++count} `
      streaming.reply += piece
      delta(piece)
    }, 20)
    return
  }
  const tokens =
    /recall/i.test(message) && !process.env.FAKE_PI_FORGET
      ? messages.flatMap((m) => JSON.stringify(m.content).match(/PHX-[A-Za-z0-9]+/g) ?? [])
      : /PHX-[A-Za-z0-9]+/.exec(message)
  const reply = (process.env.FAKE_PI_TURN !== 'wrong' && tokens?.at(-1)) || 'ok'
  delta(reply)
  if (process.env.FAKE_PI_TURN === 'fail') {
    const error = `401: invalid x-api-key ${process.env.ANTHROPIC_API_KEY}`
    return setTimeout(() => finish(message, '', 'error', error), 10)
  }
  if (process.env.FAKE_PI_TURN === 'exit') return setTimeout(() => process.exit(3), 50)
  setTimeout(() => finish(message, reply, 'stop'), 10)
}

/** What get_state reports. */
function state() {
  return {
    model: {
      provider: process.env.PI_FAKE_PROVIDER ?? flag('--provider') ?? 'fake',
      id: process.env.PI_FAKE_MODEL ?? flag('--model') ?? 'fake-model',
      contextWindow: 200000,
    },
    thinkingLevel: flag('--thinking') ?? 'off',
    isStreaming: streaming !== null,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    sessionFile,
    sessionId: id,
    sessionName: flag('-n'),
    autoCompactionEnabled: true,
    messageCount: messages.length,
    pendingMessageCount: 0,
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
      // The context-budget extension's command: no model turn.
      if (!cmd.message.startsWith('/phosphor-context-budget ')) prompt(cmd.message)
      return
    }
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
            ? [{ name: 'phosphor-context-budget', source: 'extension', sourceInfo: {} }]
            : [],
      })
    case 'get_messages':
      return respond(cmd, { messages })
    case 'get_last_assistant_text': {
      const last = messages.findLast((m) => m.role === 'assistant')
      return respond(cmd, { text: last ? last.content.map((block) => block.text).join('') : null })
    }
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
