#!/usr/bin/env node
/**
 * Live re-verification of pidex against the installed pi.
 *
 * `npm run validate` cannot do this: the e2e suite speaks to
 * `e2e/fixtures/pi-stub.cjs`, which answers a fixed script and therefore
 * cannot notice that pi's real protocol moved. This spawns a REAL
 * `pi --mode rpc` the way `electron/pi/rpc-client.ts` spawns one — same argv
 * shape, all five bundled `pi-ext/` extensions, the Claude provider with
 * `PI_CLAUDE_CLI_STRICT_MCP=1` — and drives the commands, events and response
 * fields pidex actually reads.
 *
 * It runs one real model turn, so it needs a working provider login and costs
 * a few cents. Not part of `validate`, not part of CI; run it by hand when the
 * installed pi changes minor, then update `VERIFIED_PI_LINE` in
 * `src/lib/piDrift.ts`.
 *
 *   node scripts/pi-live-smoke.mjs
 *   PI_SMOKE_MODEL=claude-haiku-4-5 node scripts/pi-live-smoke.mjs
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = process.env.PI_SMOKE_MODEL ?? 'claude-haiku-4-5'
const TURN_TIMEOUT_MS = 240_000

// Kept in sync with bundledExtensions() in electron/ipc/pi-session-handlers.ts.
const EXTENSIONS = [
  'artifacts.ts',
  'context-breakdown.ts',
  'worktree-paths.ts',
  'tool-name-guard.ts',
  'mcp-status.ts',
]

const args = [
  '--mode',
  'rpc',
  '--no-context-files',
  '--provider',
  'pi-claude-cli',
  '--model',
  MODEL,
]
for (const ext of EXTENSIONS) args.push('-e', join(REPO, 'pi-ext', ext))

const child = spawn('pi', args, {
  cwd: REPO,
  env: { ...process.env, PI_CLAUDE_CLI_STRICT_MCP: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const pending = new Map()
const events = []
const nestedAssistantEvents = []
const statusKeys = new Set()
let parseErrors = 0
let buffer = ''

// LF-only framing, like JsonlDecoder — U+2028/U+2029 are legal inside JSON
// strings and readline would split on them.
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      parseErrors++
      continue
    }
    if (record.type === 'response') {
      const resolve = pending.get(record.command)
      if (resolve) {
        pending.delete(record.command)
        resolve(record)
      }
    } else if (record.type === 'extension_ui_request') {
      if (record.method === 'setStatus') statusKeys.add(record.statusKey)
    } else {
      events.push(record.type)
      if (record.assistantMessageEvent) nestedAssistantEvents.push(record.assistantMessageEvent)
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[pi stderr] ${chunk}`))

function call(command, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    pending.set(command.type, resolve)
    child.stdin.write(`${JSON.stringify(command)}\n`)
    setTimeout(() => {
      if (pending.delete(command.type)) reject(new Error(`timeout: ${command.type}`))
    }, timeoutMs)
  })
}

let failures = 0
function check(label, passed, detail = '') {
  if (!passed) failures++
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await sleep(4000)

  const state = await call({ type: 'get_state' })
  check(
    'get_state',
    state.success && typeof state.data?.isStreaming === 'boolean',
    `model=${state.data?.model?.id} thinking=${state.data?.thinkingLevel}`,
  )

  const models = await call({ type: 'get_available_models' })
  const catalogue = models.data?.models ?? []
  check(
    'get_available_models',
    models.success && catalogue.length > 0,
    `${catalogue.length} models`,
  )

  const levels = await call({ type: 'get_available_thinking_levels' })
  check(
    'get_available_thinking_levels',
    levels.success && Array.isArray(levels.data?.levels),
    JSON.stringify(levels.data?.levels),
  )

  const commands = await call({ type: 'get_commands' })
  check(
    'get_commands',
    commands.success && Array.isArray(commands.data?.commands),
    `${commands.data?.commands?.length} commands`,
  )

  const bash = await call({ type: 'bash', command: 'echo smoke-ok', excludeFromContext: true })
  check(
    'bash',
    bash.success && String(bash.data?.output ?? '').includes('smoke-ok'),
    `exitCode=${bash.data?.exitCode}`,
  )

  events.length = 0
  const turnEnded = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (events.includes('turn_end') || events.includes('turn_aborted')) {
        clearInterval(poll)
        resolve()
      }
    }, 200)
    setTimeout(() => {
      clearInterval(poll)
      resolve()
    }, TURN_TIMEOUT_MS)
  })
  const prompt = await call({
    type: 'prompt',
    message: 'Read package.json and report the "name" field. One line.',
  })
  check('prompt accepted', prompt.success)
  await turnEnded

  check(
    'turn lifecycle',
    events.includes('turn_start') && events.includes('turn_end'),
    [...new Set(events)].join(' '),
  )
  const deltas = events.filter((type) => type === 'message_update').length
  check('message_update deltas', deltas > 0, `${deltas}`)
  const toolStarts = nestedAssistantEvents.filter((event) => event.type === 'toolcall_start')
  check(
    'nested toolcall_start carries id + toolName',
    toolStarts.length > 0 && toolStarts.every((event) => event.id && event.toolName),
    toolStarts.map((event) => event.toolName).join(',') || 'no tool call in this turn',
  )
  check('no JSONL parse errors', parseErrors === 0, `${parseErrors}`)

  const text = await call({ type: 'get_last_assistant_text' })
  check('get_last_assistant_text', text.success && !!text.data?.text)

  const stats = await call({ type: 'get_session_stats' })
  const tokens = stats.data?.tokens
  check(
    'get_session_stats tokens',
    stats.success && tokens?.total > 0,
    `in=${tokens?.input} out=${tokens?.output} cacheRead=${tokens?.cacheRead} total=${tokens?.total}`,
  )
  check(
    'get_session_stats contextUsage',
    !!stats.data?.contextUsage,
    JSON.stringify(stats.data?.contextUsage ?? null),
  )

  const messages = await call({ type: 'get_messages' })
  check(
    'get_messages',
    messages.success && Array.isArray(messages.data?.messages),
    `${messages.data?.messages?.length}`,
  )
  const entries = await call({ type: 'get_entries' })
  check(
    'get_entries',
    entries.success && Array.isArray(entries.data?.entries),
    `${entries.data?.entries?.length}`,
  )
  const tree = await call({ type: 'get_tree' })
  check('get_tree', tree.success && !!tree.data)
  const queue = await call({ type: 'clear_queue' })
  check('clear_queue', queue.success, JSON.stringify(queue.data ?? {}))
  const named = await call({ type: 'set_session_name', name: 'pi-live-smoke' })
  check('set_session_name', named.success)

  // The three extension-fed UI surfaces: two bundled, one from the provider.
  check('extension status channel', statusKeys.size > 0, [...statusKeys].join(','))
} catch (error) {
  failures++
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
}

child.stdin.end()
child.kill('SIGKILL')
console.log(failures === 0 ? '\nall green' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
