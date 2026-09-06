#!/usr/bin/env node
/**
 * Deterministic pi RPC stub for the e2e smoke test — no API key, no network.
 * Speaks the subset of the protocol the app exercises on startup and for one
 * prompt: state/models/commands/stats, then a streamed answer with an `edit`
 * tool call (drives the Files Changed panel) and an artifact_create tool call
 * (drives the Artifacts pane).
 */
'use strict'

/**
 * CLI-mode dispatch: pidex's package job runner invokes pi's package manager
 * (`pi install/remove/update`) and print mode (`pi -p …`) as subprocesses.
 * Handle those deterministically and exit before any RPC/session-file setup
 * below runs — an `install` must not create a stub session.
 */
{
  const argv = process.argv.slice(2)
  const sub = argv[0]
  if (sub === 'install' || sub === 'remove' || sub === 'update' || argv.includes('-p')) {
    const path = require('node:path')
    const fs = require('node:fs')
    const os = require('node:os')
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
    const local = argv.includes('-l')
    const settingsDir = local ? path.join(process.cwd(), '.pi') : agentDir
    const settingsPath = path.join(settingsDir, 'settings.json')
    const readSettings = () => {
      try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      } catch {
        return {}
      }
    }
    const writeSettings = (settings) => {
      fs.mkdirSync(settingsDir, { recursive: true })
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    }
    const npmName = (spec) => {
      const bare = spec.replace(/^npm:/, '')
      const at = bare.lastIndexOf('@')
      return at > 0 ? bare.slice(0, at) : bare
    }

    if (argv.includes('-p')) {
      // Print mode has two callers. Session auto-naming sends a prompt that
      // starts "You name coding sessions"; everything else is the
      // Claude-provider probe, which asserts on a fixed marker. Answering the
      // naming prompt deterministically is what lets the e2e assert on the
      // branch a new chat creates, since the branch is derived from the title.
      const naming = argv.some((a) => a.includes('You name coding sessions'))
      process.stdout.write(naming ? 'Stub Session Title\n' : 'pidex-provider-ok\n')
      process.exit(0)
    }

    const spec = argv.slice(1).find((a) => !a.startsWith('-'))
    if (sub === 'install' && spec) {
      const settings = readSettings()
      const packages = Array.isArray(settings.packages) ? settings.packages : []
      if (!packages.includes(spec)) packages.push(spec)
      writeSettings({ ...settings, packages })
      if (spec.startsWith('npm:')) {
        const dir = path.join(settingsDir, 'npm', 'node_modules', npmName(spec))
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'package.json'),
          JSON.stringify({ name: npmName(spec), version: '9.9.9-stub' }),
        )
      }
      process.stdout.write(`Installing ${spec}...\nInstalled ${spec}\n`)
      process.exit(0)
    }
    if (sub === 'remove' && spec) {
      const settings = readSettings()
      const packages = (Array.isArray(settings.packages) ? settings.packages : []).filter(
        (entry) => entry !== spec && (typeof entry !== 'object' || entry.source !== spec),
      )
      writeSettings({ ...settings, packages })
      if (spec.startsWith('npm:')) {
        fs.rmSync(path.join(settingsDir, 'npm', 'node_modules', npmName(spec)), {
          recursive: true,
          force: true,
        })
      }
      process.stdout.write(`Removed ${spec}\n`)
      process.exit(0)
    }
    // update (with or without --extensions)
    process.stdout.write('Updated packages\n')
    process.exit(0)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    let line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.trim()) {
      try {
        handle(JSON.parse(line))
      } catch {
        /* ignore malformed */
      }
    }
  }
})

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

/**
 * Honour `-n <name>` the way real pi does, so a session pidex names up front
 * reports that name back from `get_state`. Without this the stub insisted on
 * its own title and the auto-naming path was untestable end to end.
 *
 * An UNNAMED session must report no name at all — pi never titles a session by
 * itself, and every pidex auto-naming path is guarded on "has pi already got a
 * name for this?". A stub that invented one made that guard fire on every
 * session and silently disabled auto-naming end to end, which is exactly what
 * it was added to test.
 */
const NAME_FLAG = process.argv.indexOf('-n')
const SESSION_NAME =
  NAME_FLAG !== -1 && process.argv[NAME_FLAG + 1] ? process.argv[NAME_FLAG + 1] : null

// A real session file on disk in the workspace, so the app's existence
// check for the persisted resume target succeeds.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
// pi stores sessions under ~/.pi/agent/sessions/--<cwd with / as ->--/, and
// pidex's sidebar scans exactly that path. Writing here (not into the
// workspace) is what makes the session discoverable, mirroring real pi.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const SESSION_DIR = path.join(
  process.env.PI_CODING_AGENT_SESSION_DIR || path.join(AGENT_DIR, 'sessions'),
  `--${fs.realpathSync.native(process.cwd()).split(path.sep).filter(Boolean).join('-')}--`,
)
const SESSION_FILE = path.join(SESSION_DIR, `2026-01-01T00-00-00-000Z_stub-${process.pid}.jsonl`)

/**
 * Create the session directory and file, optionally late.
 *
 * Writing it synchronously — as this stub always did — makes one real bug
 * unreachable from e2e. pidex attaches a chokidar watcher to a session
 * directory as soon as the session exists, and a watcher pointed at a
 * directory that does not exist yet is born dead: chokidar never revisits a
 * missing target, so the later `add` raises no event and the sidebar row stays
 * a context-menu-less placeholder. A stub that has already created the
 * directory before pidex can attach means the watcher always finds it there,
 * and a regression test would pass against the broken code just as happily as
 * the fixed one.
 *
 * PIDEX_E2E_SESSION_WRITE_DELAY_MS reopens that window on demand, so the test
 * that covers it can actually fail when the fix is removed.
 */
function writeSessionFile() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: `stub-${process.pid}`,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'aaaa0001',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: process.env.PIDEX_STUB_SESSION_TITLE || 'stub session',
          },
        }) +
        '\n' +
        /*
         * A `-n` name belongs ON DISK, not just in `get_state`. Real pi records
         * it as a `session_info` entry, and pidex's sidebar reads names from the
         * file — so a stub that only answered the RPC left every named session
         * showing its first user message instead.
         *
         * That gap hid a real bug class: `isOrchestratorSession` recognises an
         * orchestrator by its name sentinel, so under the stub an orchestrator
         * thread sorted into the sidebar as an ordinary session.
         */
        (SESSION_NAME
          ? JSON.stringify({
              type: 'session_info',
              id: 'aaaa0000',
              parentId: null,
              timestamp: new Date().toISOString(),
              name: SESSION_NAME,
            }) + '\n'
          : ''),
    )
  } catch {
    /* best effort */
  }
}

const SESSION_WRITE_DELAY_MS = Number(process.env.PIDEX_E2E_SESSION_WRITE_DELAY_MS || 0)
if (SESSION_WRITE_DELAY_MS > 0) {
  // unref: a pending timer must never be what keeps this process alive.
  setTimeout(writeSessionFile, SESSION_WRITE_DELAY_MS).unref()
} else {
  writeSessionFile()
}

const MODEL = {
  id: 'stub-model',
  name: 'Stub Model',
  api: 'stub',
  provider: 'stub',
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/**
 * What `get_available_models` answers with.
 *
 * MODEL stays first and is what a session actually runs on. The rest exist so
 * the suite can drive the model picker's real problem: one model reachable
 * through several providers, plus a bare Bedrock foundation id that is only
 * invocable as an inference profile.
 */
const CATALOGUE = [
  MODEL,
  {
    ...MODEL,
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    reasoning: true,
  },
  {
    ...MODEL,
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'pi-claude-cli',
    reasoning: true,
  },
  {
    ...MODEL,
    id: 'anthropic.claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'amazon-bedrock',
    reasoning: true,
  },
  {
    ...MODEL,
    id: 'us.anthropic.claude-opus-5',
    name: 'Claude Opus 5 (US)',
    provider: 'amazon-bedrock',
    reasoning: true,
  },
  {
    ...MODEL,
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    reasoning: true,
  },
]

const DIFF = ' 1 export function hello() {\n-2   return "old"\n+2   return "new"\n 3 }'
const PATCH = `--- a/hello.ts\n+++ b/hello.ts\n@@ -1,3 +1,3 @@\n export function hello() {\n-  return "old"\n+  return "new"\n }`

let queueHold = false
function handle(cmd) {
  if (process.env.PIDEX_E2E_COMMAND_LOG) {
    fs.appendFileSync(process.env.PIDEX_E2E_COMMAND_LOG, JSON.stringify(cmd) + '\n')
  }
  switch (cmd.type) {
    case 'get_state':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: MODEL,
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          sessionId: 'stub-session',
          sessionName: SESSION_NAME,
          // Real pi always reports the file it persists to. The app stores
          // this as the session's disk path and reopens it on relaunch.
          sessionFile: SESSION_FILE,
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      })
      break

    case 'get_available_models':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: CATALOGUE },
      })
      break

    case 'get_commands':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: {
          commands: [{ name: 'stub-command', description: 'A stub command', source: 'extension' }],
        },
      })
      break

    case 'get_session_stats':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          sessionId: 'stub-session',
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 2,
          toolResults: 2,
          totalMessages: 4,
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: 0,
          contextUsage: { tokens: 150, contextWindow: 200000, percent: 1 },
        },
      })
      break

    case 'get_messages':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages: [] },
      })
      break

    case 'prompt': {
      out({ id: cmd.id, type: 'response', command: 'prompt', success: true })
      // Scenario switch, keyed off the prompt text: the default turn is what
      // most tests assert on, so extra scenarios must not change it.
      const message = typeof cmd.message === 'string' ? cmd.message : ''
      if (message === 'queue-hold') {
        queueHold = true
        out({ type: 'agent_start' })
        break
      }
      // Record the actual requested mode without starting overlapping fake turns.
      if (queueHold && cmd.streamingBehavior) break
      // The MCP adapter's OAuth flow: an extension command, so it runs no
      // model at all. The stub reproduces the two wire facts pidex depends on
      // — the authorization prompt arrives as an `input` request the client
      // must NOT answer, and the outcome arrives later as a `notify`.
      if (message.startsWith('/mcp-auth ')) {
        const server = message.slice('/mcp-auth '.length).trim()
        out({
          type: 'extension_ui_request',
          id: `mcp-auth-${server}`,
          method: 'input',
          title:
            `Complete ${server} OAuth\n\n` +
            `https://stub.test/oauth/authorize?server=${server}\n\n` +
            'Approve access, then paste the full localhost callback URL below.',
        })
        break
      }
      // The connection test: `/mcp reconnect <server>` is an extension
      // command too, and its verdict arrives as a `notify` — the string pidex
      // parses into an up/down badge.
      if (message.startsWith('/mcp reconnect ')) {
        const server = message.slice('/mcp reconnect '.length).trim()
        out({
          type: 'extension_ui_request',
          id: `mcp-reconnect-${server}`,
          method: 'notify',
          message: `MCP: Reconnected to ${server} (7 tools, 0 resources)`,
        })
        break
      }
      if (message.includes('longartifact')) runLongArtifactTurn()
      else if (message.includes('manyitems')) runManyItemsTurn()
      else if (message.includes('fanout')) runSubagentTurn()
      else if (message.includes('longstream')) runLongStreamTurn()
      else if (message.includes('manyturns')) runManyTurnsTurn(message.includes('tailgroup'))
      else runTurn()
      break
    }

    case 'abort':
      out({ id: cmd.id, type: 'response', command: 'abort', success: true })
      if (queueHold) {
        queueHold = false
        out({ type: 'agent_end', messages: [] })
      }
      break

    // Real pi records a rename as a `session_info` entry in the session file,
    // and pidex's sidebar reads names from disk — so a stub that only answered
    // `success: true` would make every rename appear to revert on the next
    // directory refresh, and no rename could be asserted end to end.
    case 'set_session_name':
      try {
        fs.appendFileSync(
          SESSION_FILE,
          JSON.stringify({
            type: 'session_info',
            id: `cccc${String(entrySeq).padStart(4, '0')}`,
            parentId: null,
            timestamp: new Date().toISOString(),
            name: cmd.name,
          }) + '\n',
        )
      } catch {
        /* best effort */
      }
      out({ id: cmd.id, type: 'response', command: 'set_session_name', success: true })
      break

    default:
      out({ id: cmd.id, type: 'response', command: cmd.type, success: true })
  }
}

let entrySeq = 1
/** Persist a message entry to the session file, as real pi does — the
 * sidebar scanner and Usage view read usage/cost from disk, not RPC. */
function persist(message) {
  try {
    fs.appendFileSync(
      SESSION_FILE,
      JSON.stringify({
        type: 'message',
        id: `bbbb${String(entrySeq).padStart(4, '0')}`,
        parentId: entrySeq === 1 ? 'aaaa0001' : `bbbb${String(entrySeq - 1).padStart(4, '0')}`,
        timestamp: new Date().toISOString(),
        message,
      }) + '\n',
    )
    entrySeq++
  } catch {
    /* best effort */
  }
}

function runTurn() {
  const steps = []
  const push = (fn) => steps.push(fn)

  push(() => out({ type: 'agent_start' }))
  push(() => out({ type: 'turn_start' }))
  // Extension status line styled with ANSI SGR (as pi-mcp-adapter does):
  // the app must render clean text, never raw escape bytes.
  push(() =>
    out({
      type: 'extension_ui_request',
      id: 'ext-status-1',
      method: 'setStatus',
      statusKey: 'stub-mcp',
      statusText: '[38;2;138;190;183mMCP: 2 servers enabled[39m',
    }),
  )
  // Third consecutive call: makes this a 3-tool run (grouping) and stays
  // "running" for several ticks so the in-flight animation is observable.
  push(() =>
    out({
      type: 'tool_execution_start',
      toolCallId: 'call_bash',
      toolName: 'bash',
      args: { command: 'npm test' },
    }),
  )
  // Hold this tool in flight long enough for the in-flight animation to be
  // observable by the e2e assertion (and by a human watching).
  push(() => new Promise((resolve) => setTimeout(resolve, 900)))
  push(() =>
    out({
      type: 'tool_execution_end',
      toolCallId: 'call_bash',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
    }),
  )

  push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
  for (const delta of ['Editing ', 'the ', 'file ', 'now.']) {
    push(() =>
      out({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      }),
    )
  }
  push(() =>
    out({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: {
          type: 'toolCall',
          id: 'call_edit',
          name: 'edit',
          arguments: { path: 'hello.ts', edits: [] },
        },
      },
    }),
  )
  push(() => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Editing the file now.' },
        {
          type: 'toolCall',
          id: 'call_edit',
          name: 'edit',
          arguments: { path: 'hello.ts', edits: [] },
        },
        {
          type: 'toolCall',
          id: 'call_art',
          name: 'artifact_create',
          arguments: { title: 'E2E Card' },
        },
        {
          type: 'toolCall',
          id: 'call_bash',
          name: 'bash',
          arguments: { command: 'npm test' },
        },
      ],
      stopReason: 'toolUse',
      timestamp: Date.now(),
    }
    persist(message)
    out({ type: 'message_end', message })
  })
  push(() =>
    out({
      type: 'tool_execution_start',
      toolCallId: 'call_edit',
      toolName: 'edit',
      args: { path: 'hello.ts' },
    }),
  )
  push(() =>
    out({
      type: 'tool_execution_end',
      toolCallId: 'call_edit',
      toolName: 'edit',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Edited hello.ts' }],
        details: { diff: DIFF, patch: PATCH, firstChangedLine: 2 },
      },
    }),
  )
  // Artifact tool call → drives the artifacts pane.
  push(() =>
    out({
      type: 'tool_execution_start',
      toolCallId: 'call_art',
      toolName: 'artifact_create',
      args: { title: 'E2E Card' },
    }),
  )
  push(() =>
    out({
      type: 'tool_execution_end',
      toolCallId: 'call_art',
      toolName: 'artifact_create',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Created artifact' }],
        details: {
          id: 'e2e-card',
          title: 'E2E Card',
          type: 'html',
          content: '<h1>E2E artifact</h1>',
          version: 1,
        },
      },
    }),
  )
  push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
  push(() =>
    out({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Done: **hello.ts',
      },
    }),
  )
  push(() =>
    out({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: '** updated.',
      },
    }),
  )
  push(() => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done: **hello.ts** updated.' }],
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 1200,
        output: 300,
        cacheRead: 4000,
        cacheWrite: 150,
        totalTokens: 5650,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
      },
    }
    persist(message)
    out({ type: 'message_end', message })
  })
  push(() => out({ type: 'agent_end', messages: [] }))
  push(() => out({ type: 'agent_settled' }))

  // Sequential so a step may await (used to hold a tool "running").
  void (async () => {
    for (const step of steps) {
      await step()
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  })()
}

process.on('SIGTERM', () => process.exit(0))

// ---------- extra scenarios ----------

/** Run a step list sequentially, 40ms apart, awaiting any step that returns. */
function play(steps, gapMs = 40) {
  void (async () => {
    for (const step of steps) {
      await step()
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
  })()
}

/**
 * One markdown artifact far taller than the pane, to prove the artifact pane
 * scrolls (it used to clip: PaneShell's content slot wasn't a flex container,
 * so the viewer's `flex-1` scroller collapsed to auto height).
 */
function runLongArtifactTurn() {
  const body = Array.from(
    { length: 160 },
    (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of the long artifact body.`,
  ).join('\n\n')
  const content = `# E2E Long Doc\n\n${body}\n`

  play([
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    () => out({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_long',
              name: 'artifact_create',
              arguments: { title: 'E2E Long Doc' },
            },
          ],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    () =>
      out({
        type: 'tool_execution_start',
        toolCallId: 'call_long',
        toolName: 'artifact_create',
        args: { title: 'E2E Long Doc' },
      }),
    () =>
      out({
        type: 'tool_execution_end',
        toolCallId: 'call_long',
        toolName: 'artifact_create',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'Created artifact' }],
          details: {
            id: 'e2e-long-doc',
            title: 'E2E Long Doc',
            type: 'markdown',
            content,
            version: 1,
          },
        },
      }),
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled' }),
  ])
}

/**
 * A long, slow stream plus a tool call whose identity is withheld until
 * execution starts (the Bedrock shape). Exercises two things at once:
 * scrolling back while the transcript grows, and that an unidentified tool
 * never renders as "unknown".
 */
function runLongStreamTurn() {
  const steps = [
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    () => out({ type: 'message_start', message: { role: 'assistant', content: [] } }),
  ]

  // Anonymous tool call: no id/name anywhere until tool_execution_start.
  steps.push(() =>
    out({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1 },
    }),
  )
  for (const chunk of ['{"command"', ':"npm ', 'test"}']) {
    steps.push(() =>
      out({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: chunk },
      }),
    )
  }
  steps.push(() =>
    out({
      type: 'tool_execution_start',
      toolCallId: 'late_id',
      toolName: 'bash',
      args: { command: 'npm test' },
    }),
  )

  const lines = []
  for (let i = 0; i < 70; i++) {
    const delta = `Streamed line ${i + 1} of a long reply that overflows the viewport.\n\n`
    lines.push(delta)
    steps.push(() =>
      out({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta,
        },
      }),
    )
  }

  steps.push(() =>
    out({
      type: 'tool_execution_end',
      toolCallId: 'late_id',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
    }),
  )
  steps.push(() =>
    out({
      type: 'message_end',
      message: {
        role: 'assistant',
        // message_end is authoritative in the reducer, so it has to carry the
        // whole streamed body — echoing only a summary line here collapsed the
        // transcript back to one screen and made scroll assertions meaningless.
        content: [
          { type: 'text', text: `${lines.join('')}long stream complete` },
          {
            type: 'toolCall',
            id: 'late_id',
            name: 'bash',
            arguments: { command: 'npm test' },
          },
        ],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    }),
  )
  steps.push(() => out({ type: 'agent_end', messages: [] }))
  steps.push(() => out({ type: 'agent_settled' }))

  play(steps)
}

/**
 * A finished transcript with MANY rows: prose turn, tool group, prose turn, …
 *
 * `longstream` is one giant text row, so it never exercises the case the user
 * actually hits — reading back through dozens of rows the virtualizer has
 * never measured. Each prose block here is tall enough that its real height
 * dwarfs the unmeasured-row estimate, which is what made scrolling up fight
 * back.
 */
function runManyTurnsTurn(tailGroup = false) {
  const steps = [() => out({ type: 'agent_start' }), () => out({ type: 'turn_start' })]
  for (let i = 0; i < 12; i++) {
    const body = Array.from(
      { length: 6 },
      (_, line) =>
        `Paragraph ${line + 1} of reply ${i + 1}: a block of prose tall enough to matter.`,
    ).join('\n\n')
    steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    steps.push(() =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: body }],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    )
    const id = `turns_${i}`
    steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    steps.push(() =>
      out({
        type: 'tool_execution_start',
        toolCallId: id,
        toolName: 'bash',
        args: { command: `echo turn ${i}` },
      }),
    )
    steps.push(() =>
      out({
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      }),
    )
    steps.push(() =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id, name: 'bash', arguments: { command: `echo turn ${i}` } },
          ],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    )
  }
  if (tailGroup) {
    // One tall run of tools at the very end, then a deliberate pause with it
    // still live and expanded. That pause is the only window in which a test
    // can scroll up while a big collapse is still pending — the collapse that
    // shortens the transcript BELOW the reader and used to clamp them to the
    // new bottom.
    for (let i = 0; i < 20; i++) {
      const id = `tail_${i}`
      steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
      steps.push(() =>
        out({
          type: 'tool_execution_start',
          toolCallId: id,
          toolName: 'bash',
          args: { command: `echo tail ${i}` },
        }),
      )
      steps.push(() =>
        out({
          type: 'tool_execution_end',
          toolCallId: id,
          toolName: 'bash',
          isError: false,
          result: { content: [{ type: 'text', text: 'ok' }], details: {} },
        }),
      )
      steps.push(() =>
        out({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id, name: 'bash', arguments: { command: `echo tail ${i}` } },
            ],
            stopReason: 'toolUse',
            timestamp: Date.now(),
          },
        }),
      )
    }
    // Fixed real-time hold, deliberately generous: this timer runs in the
    // stub's own process, decoupled from how long the Electron renderer
    // takes to catch up on the burst above. A short hold left almost no
    // margin on a loaded CI runner — the group could finish collapsing
    // before the test's read-back ever landed.
    steps.push(() => new Promise((resolve) => setTimeout(resolve, 10_000)))
  }
  steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
  steps.push(() =>
    out({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'many turns complete' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    }),
  )
  steps.push(() => out({ type: 'agent_end', messages: [] }))
  steps.push(() => out({ type: 'agent_settled' }))
  play(steps, 3)
}

/**
 * A Claude Code sub-agent fan-out, replayed marker for marker.
 *
 * The strings below are copied from a real captured session (pi session
 * 01a04614, 2026-08-28) and are the ONE shape pidex cannot get from any
 * pi-native provider: the CLI reports each agent three times — the model's
 * `Agent` call, `Task started`, `Task completed` — and pidex must fold them
 * into one row per agent. In that capture it did not, and three agents
 * rendered as eight rows above a strip claiming "8 sub-agents were started".
 *
 * Two agents finish; the third only ever launches, which is what a provider
 * older than 0.4.14 produces for every background agent. Both shapes appear
 * in one turn on purpose — the strip must count only the unfinished one.
 */
function runSubagentTurn() {
  const marker = (text) => [
    () => out({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      }),
  ]

  const steps = [() => out({ type: 'agent_start' }), () => out({ type: 'turn_start' })]

  // Live per-agent progress rides the status channel, never the transcript:
  // `task_progress` fires once per sub-agent tool call. Unparsed, this whole
  // payload was printed verbatim along the bottom of the window.
  steps.push(() =>
    out({
      type: 'extension_ui_request',
      id: 'ext-status-subagents',
      method: 'setStatus',
      statusKey: 'claude-subagents',
      statusText: JSON.stringify({
        tasks: [
          {
            taskId: 'a8de7d982d824b56a',
            description: 'Dig into pi-claude-cli internals',
            subagentType: 'general-purpose',
            status: 'running',
            currentStep: 'Running Read stream-parser.ts',
          },
        ],
        active: 1,
        completed: 0,
      }),
    }),
  )

  for (const text of [
    '[Claude Code · Agent {"description":"Dig into pi-claude-cli internals","subagent_type":"general-purpose","prompt":"Investigate how the @saccolabs provider keeps its CLI alive…]',
    '[Claude Code · Task {"status":"started","description":"Dig into pi-claude-cli internals","subagent_type":"general-purpose","task_id":"a8de7d982d824b56a"}]',
    '[Claude Code · Agent {"description":"Map pidex/pi dialog surfaces","subagent_type":"Explore","prompt":"Search breadth: very thorough. Read-only…]',
    '[Claude Code · Task {"status":"started","description":"Map pidex/pi dialog surfaces","subagent_type":"Explore","task_id":"a600d45bcde2ddb13"}]',
    // The third agent never gets a lifecycle event: the pre-0.4.14 shape.
    '[Claude Code · Agent {"description":"Find failing AskUserQuestion session","subagent_type":"general-purpose","prompt":"Read-only forensic task…]',
    // The two lifecycle finishes, which fold into the rows above rather than
    // adding rows of their own.
    '[Claude Code · Task {"status":"completed","description":"Dig into pi-claude-cli internals","task_id":"a8de7d982d824b56a","tool_uses":2,"total_tokens":1234,"duration_ms":900}]',
    '[Claude Code · Task {"status":"completed","description":"Map pidex/pi dialog surfaces","task_id":"a600d45bcde2ddb13","tool_uses":12,"total_tokens":48210,"duration_ms":91000}]',
  ]) {
    steps.push(...marker(text))
  }

  // The episode is over, so the live channel is cleared — the provider does
  // this at 0.4.14 so a finished turn stops claiming running agents.
  steps.push(() =>
    out({
      type: 'extension_ui_request',
      id: 'ext-status-subagents-clear',
      method: 'setStatus',
      statusKey: 'claude-subagents',
      statusText: undefined,
    }),
  )

  steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
  steps.push(() =>
    out({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Two agents reported; one never did.' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    }),
  )
  steps.push(() => out({ type: 'agent_end', messages: [] }))
  steps.push(() => out({ type: 'agent_settled' }))

  play(steps)
}

/**
 * Many short tool-only turns — the shape a long agent run actually takes (pi
 * emits a fresh message per tool round). This is the case where virtualization
 * matters: only a window of rows is in the DOM, so an over-large size estimate
 * for the rest shows up as dead space between rendered rows.
 */
function runManyItemsTurn() {
  const steps = [() => out({ type: 'agent_start' }), () => out({ type: 'turn_start' })]
  for (let i = 0; i < 40; i++) {
    const id = `many_${i}`
    steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    steps.push(() =>
      out({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
      }),
    )
    steps.push(() =>
      out({
        type: 'tool_execution_start',
        toolCallId: id,
        toolName: 'bash',
        args: { command: `echo step ${i}` },
      }),
    )
    steps.push(() =>
      out({
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      }),
    )
    steps.push(() =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id, name: 'bash', arguments: { command: `echo step ${i}` } },
          ],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    )
  }
  steps.push(() => out({ type: 'message_start', message: { role: 'assistant', content: [] } }))
  steps.push(() =>
    out({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'many items complete' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    }),
  )
  steps.push(() => out({ type: 'agent_end', messages: [] }))
  steps.push(() => out({ type: 'agent_settled' }))
  play(steps, 4)
}
