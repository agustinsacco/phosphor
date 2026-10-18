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
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const persistence = require('./fake-pi/persistence.cjs')
const { createTurns } = require('./fake-pi/turns.cjs')
const { createDispatcher } = require('./fake-pi/commands.cjs')

const args = process.argv.slice(2)
if (process.env.FAKE_PI_ARGV_FILE)
  writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(args))
if (args.includes('--version')) {
  console.log('1.2.0')
  process.exit(0)
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
// pi 1.x rejects a provider without a model before starting a session.
if (flag('--mode') === 'rpc' && args.includes('--provider') && !args.includes('--model')) {
  console.error('--provider requires --model')
  process.exit(1)
}

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
    const release = /name-until:([^\s]+)/.exec(args.join(' '))?.[1]
    const finish = () => {
      if (release) writeFileSync(`${release}.finished`, '')
      console.log('HOST_A_ONLY title')
      process.exit(0)
    }
    if (!release) return finish()
    const deadline = Date.now() + 10000
    const timer = setInterval(() => {
      if (existsSync(release)) {
        clearInterval(timer)
        finish()
      } else if (Date.now() > deadline) process.exit(1)
    }, 10)
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
const session = persistence.createSession({
  sessionFile: flag('--session'),
  folder,
  cwd: process.cwd(),
  launchName: flag('-n'),
})
/** The session's messages: those of a resumed file, then every turn saved. */
const { messages } = session
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

const persist = (message) => persistence.persist(session, message)
const turns = createTurns(session, { cwd: process.cwd(), out, persist, text })

function initialState() {
  return {
    model: {
      ...models.find((model) => model.provider === (flag('--provider') ?? 'fake')),
      // Like pi, it takes --provider only together with --model.
      provider: process.env.PI_FAKE_PROVIDER ?? (flag('--model') && flag('--provider')) ?? 'fake',
      id: process.env.PI_FAKE_MODEL ?? flag('--model') ?? 'fake-model',
      contextWindow: flag('--provider') === 'anthropic' ? 100000 : 200000,
    },
    thinkingLevel: flag('--thinking') ?? 'off',
    isStreaming: turns.state.streaming !== null,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    sessionFile: session.sessionFile,
    sessionId: session.id,
    sessionName: session.selectedName ?? flag('-n'),
    autoCompactionEnabled: true,
    messageCount: messages.length,
    pendingMessageCount: turns.state.queued.length,
  }
}

const handle = createDispatcher({
  session,
  turns,
  out,
  respond,
  fail,
  models,
  initialState,
  agentDir,
  breakdown,
})

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
