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
 * CLI-mode dispatch: Phosphor's package job runner invokes pi's package manager
 * (`pi install/remove/update`) and print mode (`pi -p …`) as subprocesses.
 * Handle those deterministically and exit before any RPC/session-file setup
 * below runs — an `install` must not create a stub session.
 */
{
  const argv = process.argv.slice(2)
  const sub = argv[0]
  if (sub === 'auth') {
    const codex = process.env.PHOSPHOR_E2E_MODEL_PROVIDER === 'openai-codex'
    const claims = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'stub-account' },
      }),
    ).toString('base64url')
    process.stdout.write(
      JSON.stringify(
        codex
          ? { status: 'ready', authType: 'oauth', credentials: `stub.${claims}.stub` }
          : { status: 'not_ready' },
      ) + '\n',
    )
    process.exit(0)
  }
  // `pi mcp list --json | login <server> | logout <server>`, as pi 1.2's
  // built-in MCP answers them. Signed-in state is a marker file per server; a
  // login waits for the test to "approve" it by writing `stub-mcp-approve-<s>`
  // so the awaiting-browser state can be asserted before it resolves.
  if (sub === 'mcp') {
    require('./pi-stub-mcp.cjs').runMcpCli(argv)
    return
  }
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
      process.stdout.write(naming ? 'Stub Session Title\n' : 'phosphor-provider-ok\n')
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

let agentStreaming = false
let swarmEnabled = false
let swarmRequested = false
function publishSwarm() {
  out({
    type: 'extension_ui_request',
    id: 'swarm-status',
    method: 'setStatus',
    statusKey: 'phosphor-swarm',
    statusText: JSON.stringify({
      version: 1,
      available: process.env.PHOSPHOR_E2E_SWARM_UNAVAILABLE !== '1',
      enabled: swarmEnabled,
      requested: swarmRequested,
    }),
  })
}
const out = (obj) => {
  if (obj.type === 'agent_start') agentStreaming = true
  if (obj.type === 'agent_settled') agentStreaming = false
  process.stdout.write(JSON.stringify(obj) + '\n')
  if (
    ['agent_start', 'agent_end', 'agent_settled'].includes(obj.type) &&
    swarmEnabled !== swarmRequested
  ) {
    swarmEnabled = swarmRequested
    publishSwarm()
  }
}

/**
 * Honour `-n <name>` the way real pi does, so a session Phosphor names up front
 * reports that name back from `get_state`. Without this the stub insisted on
 * its own title and the auto-naming path was untestable end to end.
 *
 * An UNNAMED session must report no name at all — pi never titles a session by
 * itself, and every Phosphor auto-naming path is guarded on "has pi already got a
 * name for this?". A stub that invented one made that guard fire on every
 * session and silently disabled auto-naming end to end, which is exactly what
 * it was added to test.
 */
const NAME_FLAG = process.argv.indexOf('-n')
const SESSION_NAME =
  process.env.PHOSPHOR_E2E_SESSION_NAME ??
  (NAME_FLAG !== -1 && process.argv[NAME_FLAG + 1] ? process.argv[NAME_FLAG + 1] : null)

// A real session file on disk in the workspace, so the app's existence
// check for the persisted resume target succeeds.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
// pi stores sessions under ~/.pi/agent/sessions/--<mangled cwd>--/, and
// Phosphor's sidebar scans exactly that path. Writing here (not into the
// workspace) is what makes the session discoverable, mirroring real pi. The
// mangling is pi's own rule, duplicated from electron/pi/pi-paths.ts
// (`sessionDirNameForCwd`): one leading separator dropped, then `/`, `\` and
// `:` each become a dash. Keep the two in step.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const SESSION_DIR = path.join(
  process.env.PI_CODING_AGENT_SESSION_DIR || path.join(AGENT_DIR, 'sessions'),
  `--${fs.realpathSync
    .native(process.cwd())
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`,
)
// Resume keeps the file identity, just like pi, rather than minting a duplicate row.
const RESUME_FLAG = process.argv.indexOf('--session')
// `let`: a `fork` (rewind) moves the session onto a new file, as in pi.
let SESSION_FILE =
  RESUME_FLAG !== -1
    ? process.argv[RESUME_FLAG + 1]
    : path.join(SESSION_DIR, `2026-01-01T00-00-00-000Z_stub-${process.pid}.jsonl`)

/**
 * Create the session directory and file, optionally late.
 *
 * Writing it synchronously — as this stub always did — makes one real bug
 * unreachable from e2e. Phosphor attaches a chokidar watcher to a session
 * directory as soon as the session exists, and a watcher pointed at a
 * directory that does not exist yet is born dead: chokidar never revisits a
 * missing target, so the later `add` raises no event and the sidebar row stays
 * a context-menu-less placeholder. A stub that has already created the
 * directory before Phosphor can attach means the watcher always finds it there,
 * and a regression test would pass against the broken code just as happily as
 * the fixed one.
 *
 * PHOSPHOR_E2E_SESSION_WRITE_DELAY_MS reopens that window on demand, so the test
 * that covers it can actually fail when the fix is removed.
 */
function writeSessionFile() {
  if (RESUME_FLAG !== -1 && fs.existsSync(SESSION_FILE)) return
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
            content: process.env.PHOSPHOR_STUB_SESSION_TITLE || 'stub session',
          },
        }) +
        '\n' +
        /*
         * A `-n` name belongs ON DISK, not just in `get_state`. Real pi records
         * it as a `session_info` entry, and Phosphor's sidebar reads names from the
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

const SESSION_WRITE_DELAY_MS = Number(process.env.PHOSPHOR_E2E_SESSION_WRITE_DELAY_MS || 0)
if (SESSION_WRITE_DELAY_MS > 0) {
  // unref: a pending timer must never be what keeps this process alive.
  setTimeout(writeSessionFile, SESSION_WRITE_DELAY_MS).unref()
} else {
  writeSessionFile()
}

/**
 * Context size knobs, for the context budget (electron/pi/context-budget.ts).
 * PHOSPHOR_E2E_CONTEXT_WINDOW sizes the model's window and
 * PHOSPHOR_E2E_CONTEXT_TOKENS what the context holds once a turn has run, so a
 * test can put a large-window session over the budget. Defaults keep every
 * other test at the stub's usual 150 of 200k. PHOSPHOR_E2E_MODEL_PROVIDER
 * names the provider the session reports running on, so the same session can
 * be a Claude Code one (`pi-claude-cli`) — the budget must not care.
 *
 * `compact` behaves like real pi's manual compaction in the two ways Phosphor
 * depends on: it emits compaction_start/end around a delay
 * (PHOSPHOR_E2E_COMPACT_MS), and a prompt sent while it runs is REJECTED
 * rather than queued. Afterwards the size is unknown (`tokens: null`) until
 * the next turn, as in pi.
 */
const CONTEXT_WINDOW = Number(process.env.PHOSPHOR_E2E_CONTEXT_WINDOW || 200000)
const CONTEXT_TOKENS = Number(process.env.PHOSPHOR_E2E_CONTEXT_TOKENS || 150)
const COMPACT_MS = Number(process.env.PHOSPHOR_E2E_COMPACT_MS || 40)
const MODEL_PROVIDER = process.env.PHOSPHOR_E2E_MODEL_PROVIDER || 'stub'
let contextTokens = 150
let compacting = false

const MODEL = {
  id: 'stub-model',
  name: process.env.PHOSPHOR_E2E_SESSION_NAME ? 'LOCAL_ONLY Model' : 'Stub Model',
  api: 'stub',
  provider: MODEL_PROVIDER,
  reasoning: false,
  input: ['text'],
  contextWindow: CONTEXT_WINDOW,
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

/**
 * pi's `data.disposition` for an accepted prompt (pi >= 0.99). The stub's
 * `/...` scenarios stand in for extension commands, which pi reports as
 * `handled`: no run starts on their account. A skill (`/skill:`) expands into
 * a prompt and starts one, like plain text.
 */
function promptDisposition(cmd) {
  if (cmd.streamingBehavior && agentStreaming) return 'queued'
  const message = typeof cmd.message === 'string' ? cmd.message : ''
  if (message.startsWith('/') && !message.startsWith('/skill:')) return 'handled'
  return 'started'
}

/**
 * A forked branch pi has not written yet (header first), or null.
 *
 * pi's `createBranchedSession` writes the new file at once only when the
 * copied branch holds an assistant reply; a rewind to the first message leaves
 * nothing on disk until the next turn ends. Mirrored here so e2e sees the same
 * window in which the new file does not exist yet.
 */
let unwrittenFork = null
/** After a fork, the id the next entry chains from (the branch's leaf). */
let forkLeaf
function flushFork() {
  if (!unwrittenFork) return
  fs.writeFileSync(SESSION_FILE, unwrittenFork.map((e) => JSON.stringify(e)).join('\n') + '\n')
  unwrittenFork = null
}

/** pi's `fork`: copy the branch up to just before `entryId` into a new file. */
function forkSession(entryId) {
  const entries = sessionEntries()
  const target = entries.find((entry) => entry.id === entryId)
  if (!target) return null
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch = []
  for (let at = byId.get(target.parentId); at; at = byId.get(at.parentId)) branch.unshift(at)
  const timestamp = new Date().toISOString()
  const id = `stub-fork-${process.pid}-${Date.now()}`
  const header = { type: 'session', version: 3, id, timestamp, cwd: process.cwd() }
  unwrittenFork = [{ ...header, parentSession: SESSION_FILE }, ...branch]
  SESSION_FILE = path.join(SESSION_DIR, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  forkLeaf = branch.at(-1)?.id ?? null
  if (branch.some((entry) => entry.message?.role === 'assistant')) flushFork()
  const content = target.message?.content
  return typeof content === 'string' ? content : ''
}

function sessionEntries() {
  if (unwrittenFork) return unwrittenFork.filter((entry) => entry.type !== 'session')
  return fs
    .readFileSync(SESSION_FILE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== 'session')
}
let queueHold = false
let finishNativeSubagent
let finishParallelAgents
function handle(cmd) {
  if (process.env.PHOSPHOR_E2E_COMMAND_LOG) {
    fs.appendFileSync(process.env.PHOSPHOR_E2E_COMMAND_LOG, JSON.stringify(cmd) + '\n')
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
          isStreaming: agentStreaming,
          isCompacting: compacting,
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

    case 'get_commands': {
      publishSwarm()
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: { commands: require('./pi-stub-commands.cjs') },
      })
      break
    }

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
          contextUsage: {
            tokens: contextTokens,
            contextWindow: CONTEXT_WINDOW,
            percent: contextTokens === null ? null : (contextTokens / CONTEXT_WINDOW) * 100,
          },
        },
      })
      break

    case 'compact': {
      compacting = true
      const tokensBefore = contextTokens ?? 0
      out({ type: 'compaction_start', reason: 'manual' })
      setTimeout(() => {
        compacting = false
        contextTokens = null
        const result = {
          summary: 'Stub summary of the earlier conversation.',
          firstKeptEntryId: 'aaaa0001',
          tokensBefore,
        }
        out({ type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false })
        out({ id: cmd.id, type: 'response', command: 'compact', success: true, data: result })
      }, COMPACT_MS)
      break
    }

    case 'get_messages':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_messages',
        success: true,
        data: {
          messages: sessionEntries()
            .filter(
              (e) =>
                !sessionEntries().some(
                  (entry) => entry.type === 'compaction' && entry.id === 'stub-workflow-compact',
                ) && e.id.startsWith('workflow-evidence-'),
            )
            .map((e) => ({ ...e, role: 'custom' })),
        },
      })
      break

    case 'get_entries': {
      const entries = sessionEntries()
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_entries',
        success: true,
        data: { entries, leafId: entries.at(-1)?.id ?? null },
      })
      break
    }
    case 'prompt': {
      if (require('./pi-stub-mcp.cjs').handleMcpControl(cmd, out, agentStreaming || compacting))
        break
      if (/^\/phosphor-swarm (on|off)$/.test(cmd.message)) {
        if (cmd.message.endsWith(' on') && process.env.PHOSPHOR_E2E_SWARM_UNAVAILABLE === '1') {
          out({
            id: cmd.id,
            type: 'response',
            command: 'prompt',
            success: false,
            error: 'Swarm requires pi-subagents loaded and available in this session.',
          })
          break
        }
        swarmRequested = cmd.message.endsWith(' on')
        if (!agentStreaming) swarmEnabled = swarmRequested
        publishSwarm()
        out({
          id: cmd.id,
          type: 'response',
          command: 'prompt',
          success: true,
          data: { disposition: 'handled' },
        })
        break
      }
      if (compacting) {
        out({
          id: cmd.id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: 'Cannot submit a prompt while compaction is in progress',
        })
        break
      }
      out({
        id: cmd.id,
        type: 'response',
        command: 'prompt',
        success: true,
        data: { disposition: promptDisposition(cmd) },
      })
      contextTokens = CONTEXT_TOKENS
      // Scenario switch, keyed off the prompt text: the default turn is what
      // most tests assert on, so extra scenarios must not change it.
      const message = typeof cmd.message === 'string' ? cmd.message : ''
      if (message === 'LOCAL_ONLY fail-turn') {
        const failed = {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'LOCAL_ONLY provider error',
        }
        out({ type: 'agent_start' })
        persist({ role: 'user', content: message })
        out({ type: 'message_start', message: failed })
        persist(failed)
        out({ type: 'message_end', message: failed })
        out({ type: 'agent_end', messages: [failed] })
        out({ type: 'agent_settled', aborted: false })
        break
      }
      if (message === 'contextsources') {
        out({
          type: 'extension_ui_request',
          id: 'ext-context-sources',
          method: 'setStatus',
          statusKey: 'phosphor-context-breakdown',
          statusText: JSON.stringify({
            parts: {},
            contextFiles: {
              off: [],
              files: [
                {
                  path: path.join(AGENT_DIR, 'AGENTS.md'),
                  kind: 'agents',
                  scope: 'global',
                  tokens: 200,
                  included: true,
                },
                {
                  path: path.join(process.cwd(), 'AGENTS.md'),
                  kind: 'agents',
                  scope: 'project',
                  tokens: 800,
                  included: true,
                },
              ],
            },
          }),
        })
        runTurn()
        break
      }
      if (message.startsWith('/subagents-steer ')) {
        const requestId = `steer-${Date.now()}`
        for (const [i, content] of [
          'Running subagent...',
          'Steering delivered to the addressed child.',
        ].entries()) {
          const notice = {
            role: 'custom',
            customType: 'subagent-slash-result',
            content,
            display: i === 0,
            details: { requestId },
          }
          fs.appendFileSync(
            SESSION_FILE,
            JSON.stringify({
              ...notice,
              type: 'custom_message',
              id: `${requestId}-${i}`,
              parentId: sessionEntries().at(-1)?.id ?? null,
              timestamp: new Date().toISOString(),
            }) + '\n',
          )
          out({ type: 'message_end', message: notice })
        }
        break
      }
      if (message.startsWith('/phosphor-save-subagent-snapshot ')) {
        // This is still a stubbed receipt. The shared formatter avoids a second
        // Markdown protocol; native appendEntry is tested separately with real Pi.
        const {
          snapshotContent,
        } = require('../../../../libs/pi-extensions/pi-ext/subagent-snapshot.ts')
        const [, requestId, payload] = message.split(' ')
        const artifact = {
          id: `subagent-${require('node:crypto').randomUUID()}`,
          title: 'Saved subagent snapshot',
          type: 'markdown',
          version: 1,
          content: snapshotContent(JSON.parse(decodeURIComponent(payload)), 'stub-session'),
        }
        fs.appendFileSync(
          SESSION_FILE,
          JSON.stringify({
            type: 'custom',
            customType: 'phosphor-saved-artifact',
            id: artifact.id,
            parentId: sessionEntries().at(-1)?.id ?? null,
            timestamp: new Date().toISOString(),
            data: artifact,
          }) + '\n',
        )
        out({
          type: 'extension_ui_request',
          id: requestId,
          method: 'setWidget',
          widgetKey: 'phosphor-subagent-save',
          widgetLines: [`PHOSPHOR_SUBAGENT_SAVE:${JSON.stringify({ requestId, artifact })}`],
        })
        out({
          type: 'extension_ui_request',
          id: `${requestId}-clear`,
          method: 'setWidget',
          widgetKey: 'phosphor-subagent-save',
        })
        break
      }
      if (message === '/stub-expire-and-compact-workflow') {
        fs.appendFileSync(
          SESSION_FILE,
          JSON.stringify({
            type: 'compaction',
            id: 'stub-workflow-compact',
            parentId: sessionEntries().at(-1)?.id ?? null,
            timestamp: new Date().toISOString(),
            summary: 'Workflow evidence compacted.',
            firstKeptEntryId: 'stub-workflow-compact',
            tokensBefore: 1000,
          }) + '\n',
        )
        publishWorkflowFleet(true)
        break
      }
      if (message === '/stub-subagent-layout-update') {
        publishWorkflowFleet(false, true)
        break
      }
      if (message.startsWith('/subagents-inspect-rpc ')) {
        const [, requestId, asyncId, childId] = message.split(' ')
        const reply = {
          kind: 'pi-subagents.inspect-reply',
          version: 1,
          requestId,
          asyncId,
          ...(childId !== '--lines' ? { childId } : {}),
          ...(asyncId.startsWith('1000000')
            ? {
                label: asyncId.startsWith('10000001') ? 'reviewer' : 'validation',
                status: asyncId.startsWith('10000001') ? 'complete' : 'running',
                finalOutput: asyncId.startsWith('10000001')
                  ? 'CHANGES_REQUESTED: the review ran successfully, but found a regression.'
                  : undefined,
              }
            : { label: 'scout', status: 'running', task: 'Map the auth flow' }),
          messages: [
            {
              role: 'assistant',
              kind: 'text',
              text:
                asyncId.startsWith('10000002') || childId === 'validation'
                  ? 'Validation: full suite is running. The previous bash command has finished.'
                  : 'Inspection: following login.ts to verify.ts.',
            },
          ],
          ...(process.env.PHOSPHOR_E2E_SUBAGENT_LAYOUT
            ? {
                task: '## Validate module boundaries\n\n- Check imports and shared contracts.\n- Report regressions independently.\n\nKeep changes within the assigned scope.',
                messages: Array.from({ length: 40 }, (_, i) => [
                  {
                    role: 'assistant',
                    text: `### Inspecting module ${i}\n\nFollowing the call chain and checking the surrounding implementation.`,
                  },
                  { role: 'assistant', text: '[tool: read]' },
                  {
                    role: 'toolResult',
                    text: `Module ${i} output\n${'export const result = inspectModule()\n'.repeat(30)}`,
                  },
                ]).flat(),
              }
            : {}),
          truncated: { task: false, messages: 2, finalOutput: false },
          ...(sessionEntries().some((e) => e.id === 'stub-workflow-compact')
            ? { error: { code: 'not_found', message: 'Native inspection artifacts expired.' } }
            : {}),
        }
        out({
          type: 'extension_ui_request',
          id: 'inspect-reply',
          method: 'setWidget',
          widgetKey: 'subagent-inspect',
          widgetLines: [`PI_SUBAGENT_INSPECT_JSON:${JSON.stringify(reply)}`],
        })
        out({
          type: 'extension_ui_request',
          id: 'inspect-clear',
          method: 'setWidget',
          widgetKey: 'subagent-inspect',
        })
        break
      }
      if (message === '/stub-hide-workflow-status') {
        out({
          type: 'extension_ui_request',
          id: 'hide-fleet',
          method: 'setWidget',
          widgetKey: 'subagent-async',
        })
        break
      }
      if (message === '/stub-restore-workflow-status') {
        publishWorkflowFleet(false)
        break
      }
      if (message === '/stub-settle-workflow') {
        publishWorkflowFleet(true)
        break
      }
      // Release only the stub's scripted child, after the test inspects it.
      if (message === '/stub-finish-delegation') {
        finishNativeSubagent?.()
        finishNativeSubagent = undefined
        break
      }
      if (message === '/stub-finish-parallel') {
        finishParallelAgents?.()
        finishParallelAgents = undefined
        break
      }
      // Hold precisely between agent_end and agent_settled, like native
      // post-run compaction. Only the test's explicit release ends the hold.
      if (message === '/stub-swarm-post-run') {
        out({ type: 'agent_start' })
        out({ type: 'agent_end', messages: [] })
        out({ type: 'compaction_start', reason: 'threshold' })
        break
      }
      if (message === '/stub-settle-swarm') {
        out({
          type: 'compaction_end',
          reason: 'threshold',
          result: null,
          aborted: false,
          willRetry: false,
        })
        out({ type: 'agent_settled', aborted: false })
        break
      }
      if (message === 'queue-hold' || message.endsWith('\nroutine-e2e-hold')) {
        queueHold = true
        out({ type: 'agent_start' })
        break
      }
      // Record the actual requested mode without starting overlapping fake turns.
      if (queueHold && cmd.streamingBehavior) break
      // An extension `notify` whose text is one unbreakable path, the shape of
      // an ENOENT error — the widest thing a notice card is ever asked to hold.
      if (message.includes('longnotify')) {
        out({
          type: 'extension_ui_request',
          id: 'long-notify',
          method: 'notify',
          notifyType: 'error',
          message:
            'ENOENT: no such file or directory, open /Users/dev/projects/phosphor/.phosphor/' +
            'worktrees/notifications-overflowing-the-right-edge/src/features/extension-ui/' +
            'ExtensionUiHosts.tsx',
        })
      }
      if (message === 'PHX-receipt') runReceiptTurn()
      else if (message.includes('mermaidviewer')) {
        runTextTurn(
          '```mermaid\nflowchart LR\n' +
            Array.from({ length: 12 }, (_, i) => `N${i}[Stage ${i}] --> N${i + 1}`).join('\n') +
            '\n```',
        )
      } else if (message === 'terminal-command') {
        runTextTurn('```bash\nprintf one >> command-ran.txt\nprintf two >> command-ran.txt\n```')
      } else if (message.includes('speclink')) runTextTurn()
      else if (message.includes('artifactlink')) runArtifactLinkTurn()
      else if (message.includes('longartifact')) runLongArtifactTurn()
      else if (message.includes('manyitems')) runManyItemsTurn()
      else if (message.includes('workflow-evidence')) runWorkflowEvidenceTurn()
      else if (message.includes('in parallel')) runParallelAgentsTurn()
      else if (message.includes('delegate')) runNativeSubagentTurn()
      else if (message.includes('fanout')) runSubagentTurn()
      else if (message.includes('longstream')) runLongStreamTurn()
      else if (message.includes('thinkstream')) runThinkingTurn()
      else if (message.includes('manyturns')) runManyTurnsTurn(message.includes('tailgroup'))
      else runTurn()
      break
    }

    case 'fork': {
      const text = forkSession(cmd.entryId)
      out(
        text === null
          ? { id: cmd.id, type: 'response', command: 'fork', success: false, error: 'not found' }
          : {
              id: cmd.id,
              type: 'response',
              command: 'fork',
              success: true,
              data: { text, cancelled: false },
            },
      )
      break
    }

    case 'abort':
      out({ id: cmd.id, type: 'response', command: 'abort', success: true })
      if (queueHold) {
        queueHold = false
        out({ type: 'agent_end', messages: [] })
        out({ type: 'agent_settled', aborted: true })
      }
      break

    // Real pi records a rename as a `session_info` entry in the session file,
    // and Phosphor's sidebar reads names from disk — so a stub that only answered
    // `success: true` would make every rename appear to revert on the next
    // directory refresh, and no rename could be asserted end to end.
    case 'set_session_name':
      try {
        const entry = {
          type: 'session_info',
          id: `cccc${String(entrySeq).padStart(4, '0')}`,
          parentId: sessionEntries().at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          name: cmd.name,
        }
        // An unwritten fork keeps it in memory, as pi does until a reply lands.
        if (unwrittenFork) unwrittenFork.push(entry)
        else fs.appendFileSync(SESSION_FILE, JSON.stringify(entry) + '\n')
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
    flushFork()
    const id = `bbbb${String(entrySeq).padStart(4, '0')}`
    const sequential = entrySeq === 1 ? 'aaaa0001' : `bbbb${String(entrySeq - 1).padStart(4, '0')}`
    fs.appendFileSync(
      SESSION_FILE,
      JSON.stringify({
        type: 'message',
        id,
        // After a fork, chain from the branch's leaf, as pi does, so a second
        // rewind walks a real branch rather than a link into the old file.
        parentId: forkLeaf === undefined ? sequential : forkLeaf,
        timestamp: new Date().toISOString(),
        message,
      }) + '\n',
    )
    if (forkLeaf !== undefined) forkLeaf = id
    entrySeq++
  } catch {
    /* best effort */
  }
}

async function runReceiptTurn() {
  out({ type: 'agent_start' })
  // Settle only after the test has left the lane, which it signals with a file in
  // the workspace above this worktree. A fixed delay raced slow CI runners.
  const go = [0, 1, 2, 3].map((up) =>
    path.join(process.cwd(), ...Array(up).fill('..'), '.phx-receipt-go'),
  )
  const until = Date.now() + 15_000
  await new Promise((resolve) => setTimeout(resolve, 700))
  while (Date.now() < until && !go.some((file) => fs.existsSync(file)))
    await new Promise((resolve) => setTimeout(resolve, 100))
  fs.writeFileSync('hello.ts', 'export const hello = "receipt"\n')
  for (const [name, args, result] of [
    [
      'edit',
      { path: 'hello.ts' },
      { content: [{ type: 'text', text: 'Edited hello.ts' }], details: { diff: '-1 old\n+1 new' } },
    ],
    [
      'bash',
      { command: 'npm test' },
      { content: [{ type: 'text', text: '1 test passed' }], details: { exitCode: 0 } },
    ],
  ]) {
    const toolCallId = `receipt_${name}`
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name, arguments: args }],
      stopReason: 'toolUse',
      timestamp: Date.now(),
    }
    out({ type: 'message_start', message: call })
    persist(call)
    out({ type: 'message_end', message: call })
    out({ type: 'tool_execution_start', toolCallId, toolName: name, args })
    out({ type: 'tool_execution_end', toolCallId, toolName: name, isError: false, result })
    const resultMessage = {
      role: 'toolResult',
      toolCallId,
      toolName: name,
      ...result,
      isError: false,
      timestamp: Date.now(),
    }
    persist(resultMessage)
    out({ type: 'message_end', message: resultMessage })
  }
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Receipt ready.' }],
    stopReason: 'stop',
    timestamp: Date.now(),
  }
  out({ type: 'message_start', message })
  persist(message)
  out({ type: 'message_end', message })
  out({ type: 'agent_end', messages: [message] })
  out({ type: 'agent_settled', aborted: false })
}

function runTurn() {
  const steps = []
  const push = (fn) => steps.push(fn)

  push(() => out({ type: 'agent_start' }))
  push(() => out({ type: 'turn_start' }))
  // Extension status line styled with ANSI SGR, as extensions do: the app
  // must render clean text, never raw escape bytes.
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
          arguments: {
            title: process.env.PHOSPHOR_E2E_SESSION_NAME ? 'LOCAL_ONLY Card' : 'E2E Card',
          },
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
      args: { title: process.env.PHOSPHOR_E2E_SESSION_NAME ? 'LOCAL_ONLY Card' : 'E2E Card' },
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
          title: process.env.PHOSPHOR_E2E_SESSION_NAME ? 'LOCAL_ONLY Card' : 'E2E Card',
          type: 'html',
          content: process.env.PHOSPHOR_E2E_SESSION_NAME
            ? '<h1>LOCAL_ONLY artifact</h1>'
            : '<h1>E2E artifact</h1>',
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
  push(() => out({ type: 'agent_settled', aborted: false }))

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
 * A reply that announces a spec it wrote: one repo-relative link and one web
 * URL, the exact shape a real session produces after writing a doc.
 */
function runTextTurn(
  text = 'Spec written: [docs/plan.md](docs/plan.md), line ' +
    '[42](docs/plan.md#L42). PR: [#214](https://github.com/agustinsacco/Phosphor/pull/214).',
) {
  play([
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
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
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled', aborted: false }),
  ])
}

/**
 * An artifact, then the hand-off line real models write about it: an
 * `artifact://<id>` link back to what they just produced. The link was inert
 * until Phosphor learned the scheme — an unknown scheme classified the same as
 * `javascript:`, so the click did nothing at all.
 */
function runArtifactLinkTurn() {
  const details = {
    id: 'e2e-linked-doc',
    title: 'E2E Linked Doc',
    type: 'markdown',
    content: '# E2E Linked Doc\n\nThe artifact the chat link points at.\n',
    version: 1,
  }
  play([
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    () => out({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    () => {
      const message = {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_link_art',
            name: 'artifact_create',
            arguments: { title: 'E2E Linked Doc' },
          },
        ],
        stopReason: 'toolUse',
        timestamp: Date.now(),
      }
      persist(message)
      out({ type: 'message_end', message })
    },
    () =>
      out({
        type: 'tool_execution_start',
        toolCallId: 'call_link_art',
        toolName: 'artifact_create',
        args: { title: 'E2E Linked Doc' },
      }),
    () =>
      out({
        type: 'tool_execution_end',
        toolCallId: 'call_link_art',
        toolName: 'artifact_create',
        isError: false,
        result: { content: [{ type: 'text', text: 'Created artifact' }], details },
      }),
    // Real pi records the result in the session file. It is how the artifact
    // outlives the session's context: `get_messages` here answers nothing at
    // all, exactly like a real session whose artifact was compacted away.
    () =>
      persist({
        role: 'toolResult',
        toolCallId: 'call_link_art',
        toolName: 'artifact_create',
        content: [{ type: 'text', text: 'Created artifact' }],
        details,
        isError: false,
        timestamp: Date.now(),
      }),
    // A fresh assistant message, so the tool row keeps its own activity group.
    () => out({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              // Two forms in one message: a markdown link, and the backticked
              // URL models actually write most often (inert until
              // remarkArtifactLinks promoted it).
              text:
                'Done — [Preview the design](artifact://e2e-linked-doc).\n\n' +
                '- Delivered companion artifact: `artifact://e2e-linked-doc`\n',
            },
          ],
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      }),
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled', aborted: false }),
  ])
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
    () => out({ type: 'agent_settled', aborted: false }),
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
  steps.push(() => out({ type: 'agent_settled', aborted: false }))

  play(steps)
}

/**
 * A Codex-shaped thought: two bold-titled sections, held open long enough to
 * see the live line ("Thinking Ns · <latest title>"), then a tool call and an
 * answer. The thought then folds into "Thought for Ns · <first title>".
 */
function runThinkingTurn() {
  const msg = { role: 'assistant', content: [] }
  const think = (assistantMessageEvent) =>
    out({ type: 'message_update', message: msg, assistantMessageEvent })
  const first = '**Reading the spec**\n\nThe plan lives in docs/plan.md.'
  const second = '\n\n**Planning the change**\n\nOne edit, then the tests.'
  play([
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    () => out({ type: 'message_start', message: msg }),
    () => think({ type: 'thinking_start', contentIndex: 0 }),
    () => think({ type: 'thinking_delta', contentIndex: 0, delta: first }),
    () => think({ type: 'thinking_delta', contentIndex: 0, delta: second }),
    () => new Promise((resolve) => setTimeout(resolve, 1500)),
    () => think({ type: 'thinking_end', contentIndex: 0, content: first + second }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: first + second },
            { type: 'toolCall', id: 'think_ls', name: 'bash', arguments: { command: 'ls' } },
          ],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    () =>
      out({
        type: 'tool_execution_start',
        toolCallId: 'think_ls',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    () =>
      out({
        type: 'tool_execution_end',
        toolCallId: 'think_ls',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'docs' }], details: {} },
      }),
    () => out({ type: 'message_start', message: msg }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Thought it through.' }],
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      }),
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled', aborted: false }),
  ])
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
  steps.push(() => out({ type: 'agent_settled', aborted: false }))
  play(steps, 3)
}

/**
 * A Claude Code sub-agent fan-out, replayed marker for marker.
 *
 * The strings below are copied from a real captured session (pi session
 * 01a04614, 2026-08-28) and are the ONE shape Phosphor cannot get from any
 * pi-native provider: the CLI reports each agent three times — the model's
 * `Agent` call, `Task started`, `Task completed` — and Phosphor must fold them
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
    '[Claude Code · Agent {"description":"Map phosphor/pi dialog surfaces","subagent_type":"Explore","prompt":"Search breadth: very thorough. Read-only…]',
    '[Claude Code · Task {"status":"started","description":"Map phosphor/pi dialog surfaces","subagent_type":"Explore","task_id":"a600d45bcde2ddb13"}]',
    // The third agent never gets a lifecycle event: the pre-0.4.14 shape.
    '[Claude Code · Agent {"description":"Find failing AskUserQuestion session","subagent_type":"general-purpose","prompt":"Read-only forensic task…]',
    // The two lifecycle finishes, which fold into the rows above rather than
    // adding rows of their own.
    '[Claude Code · Task {"status":"completed","description":"Dig into pi-claude-cli internals","task_id":"a8de7d982d824b56a","tool_uses":2,"total_tokens":1234,"duration_ms":900}]',
    '[Claude Code · Task {"status":"completed","description":"Map phosphor/pi dialog surfaces","task_id":"a600d45bcde2ddb13","tool_uses":12,"total_tokens":48210,"duration_ms":91000}]',
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
  steps.push(() => out({ type: 'agent_settled', aborted: false }))

  play(steps)
}

/** Replay recorded 0.76.1 workflow notices without a model or live child. */
function runWorkflowEvidenceTurn() {
  const fixture = require('../../../../libs/client-ui/src/features/chat/__fixtures__/subagent-workflow.json')
  let parentId = sessionEntries().at(-1)?.id ?? null
  fixture.messages.forEach((message, i) => {
    const entry = { ...message, type: 'custom_message', id: `workflow-evidence-${i}`, parentId }
    fs.appendFileSync(SESSION_FILE, JSON.stringify(entry) + '\n')
    parentId = entry.id
    out({ type: 'message_end', message })
  })
  publishWorkflowFleet()
  runTextTurn('Reviewer reported; validation and QA continue independently.')
}

const layoutStartedAt = Date.now() - 250_000
function publishWorkflowFleet(settled = false, updated = false) {
  const snapshot = structuredClone(
    require('../../../../libs/client-ui/src/features/chat/__fixtures__/subagent-workflow.json')
      .snapshot,
  )
  if (process.env.PHOSPHOR_E2E_SUBAGENT_LAYOUT) {
    const child = snapshot.runs[0].children[1]
    snapshot.runs[0].startedAt = layoutStartedAt - 10_000
    for (const step of snapshot.runs[0].children) {
      if (step.state === 'running') step.startedAt = layoutStartedAt
    }
    child.activity = {
      toolCount: updated ? 100 : 99,
      turnCount: updated ? 100 : 99,
      currentTool: updated ? `grep ${'a-long-path/'.repeat(15)}module.ts` : undefined,
      state: updated ? 'needs_attention' : 'running',
    }
    snapshot.runs[0].children.push(
      ...Array.from({ length: 12 }, (_, i) => ({
        ...child,
        id: `layout-${i}`,
        label: `Audit module ${i}: long navigation labels stay on one line`,
      })),
    )
  }
  if (settled) {
    for (const run of snapshot.runs) {
      run.state = 'complete'
      for (const child of run.children) child.state = 'complete'
    }
  }
  out({
    type: 'extension_ui_request',
    id: 'workflow-fleet',
    method: 'setWidget',
    widgetKey: 'subagent-async',
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`],
  })
}

/**
 * Native delegation through pi-subagents, for both providers. Three wire facts
 * captured from session 01a0e90a (0.73.1): foreground progress/results,
 * the detached run's structured widget, and its hidden completion notice.
 */
function runNativeSubagentTurn() {
  // CI rendering speed must not decide whether the child can be inspected.
  const completion = new Promise((resolve) => {
    finishNativeSubagent = resolve
  })
  const details = {
    requestId: 'question-a',
    runId: 'run-a',
    agent: 'worker',
    childIndex: 0,
    requestBody: 'Use the shared parser?',
  }
  const records = [
    {
      type: 'custom_message',
      id: 'question-a',
      parentId: 'aaaa0001',
      customType: 'subagent_supervisor_request',
      content: details.requestBody,
      display: true,
      details,
    },
    {
      type: 'custom',
      id: 'reply-a',
      parentId: 'question-a',
      customType: 'subagent_supervisor_reply',
      data: { ...details, message: 'Use the shared parser.' },
    },
  ]
  fs.appendFileSync(SESSION_FILE, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  const msg = { role: 'assistant', content: [] }
  const ASYNC_ID = 'a1b2c3d4-0000-4000-8000-000000000000'
  const foreground = { agent: 'reviewer', task: 'Review the auth diff for regressions' }
  const background = { agent: 'scout', task: 'Map the auth flow', async: true }
  const child = (progress, result) => ({
    mode: 'single',
    results: [
      {
        index: 0,
        agent: 'reviewer',
        task: '[prompt redacted]',
        sessionName: 'reviewer: Review the auth diff for regressions',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        ...result,
      },
    ],
    progress: [
      {
        index: 0,
        agent: 'reviewer',
        task: '[prompt redacted]',
        recentTools: [{ tool: 'read', args: 'SKILL.md', endMs: 1 }],
        recentOutput: [],
        model: 'stub/stub-model',
        ...progress,
      },
    ],
  })
  const review =
    'No regressions found. One nit: `auth.ts:42` ignores the error branch of `verify()`.'
  const fleet =
    'PI_SUBAGENT_ASYNC_JSON:' +
    JSON.stringify({
      kind: 'pi-subagents.async-status-snapshot',
      version: 1,
      generatedAt: Date.now(),
      caps: {
        maxRuns: 20,
        maxChildrenPerNode: 8,
        maxDepth: 3,
        maxStringLength: 160,
        maxSerializedBytes: 32768,
      },
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      runs: [
        {
          id: ASYNC_ID,
          kind: 'subagent',
          label: 'scout',
          state: 'running',
          startedAt: Date.now(),
          activity: { lastActivityAt: Date.now(), turnCount: 1, toolCount: 2 },
          children: [
            {
              id: 'step:0',
              kind: 'step',
              label: 'scout',
              state: 'running',
              startedAt: Date.now(),
              activity: { currentTool: 'grep', turnCount: 1, toolCount: 2 },
            },
          ],
        },
      ],
    })
  const notify = {
    role: 'custom',
    customType: 'subagent-notify',
    display: false,
    // Current pi-subagents includes explicit identity, unlike legacy text-only notices.
    details: { runs: [{ runId: ASYNC_ID, agent: 'scout', status: 'completed' }] },
    content:
      'Background task completed: **scout**\n\nscout:\nThe auth flow enters at `login.ts` and settles in `session.ts`.\n\nRetention-managed async directory: /tmp/stub/async/' +
      ASYNC_ID,
    timestamp: Date.now(),
  }
  const call = (id, args) => [
    () => out({ type: 'message_start', message: msg }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id, name: 'subagent', arguments: args }],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    () => out({ type: 'tool_execution_start', toolCallId: id, toolName: 'subagent', args }),
  ]
  const say = (text) => [
    () => out({ type: 'message_start', message: msg }),
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

  play([
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    ...call('sub_fg', foreground),
    () =>
      out({
        type: 'tool_execution_update',
        toolCallId: 'sub_fg',
        toolName: 'subagent',
        partialResult: {
          content: [{ type: 'text', text: 'reviewer: running' }],
          details: child(
            {
              status: 'running',
              currentTool: 'read',
              currentToolArgs: 'src/auth.ts',
              toolCount: 3,
              turnCount: 2,
              tokens: 2100,
              durationMs: 4000,
            },
            {},
          ),
        },
      }),
    () => new Promise((resolve) => setTimeout(resolve, 900)),
    () =>
      out({
        type: 'tool_execution_end',
        toolCallId: 'sub_fg',
        toolName: 'subagent',
        isError: false,
        result: {
          content: [{ type: 'text', text: review }],
          details: child(
            { status: 'completed', toolCount: 4, turnCount: 3, tokens: 4000, durationMs: 9100 },
            {
              exitCode: 0,
              usage: { input: 3100, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 },
              finalOutput: review,
              sessionFile: '/tmp/stub/sessions/reviewer-1.jsonl',
            },
          ),
        },
      }),
    ...call('sub_bg', background),
    () =>
      out({
        type: 'tool_execution_end',
        toolCallId: 'sub_bg',
        toolName: 'subagent',
        isError: false,
        result: {
          content: [
            {
              type: 'text',
              text: `Async: scout [${ASYNC_ID}]\n\nThe async run is detached and running in the background.`,
            },
          ],
          details: {
            mode: 'single',
            runId: ASYNC_ID,
            asyncId: ASYNC_ID,
            results: [],
            background: true,
            timeoutMs: 1800000,
          },
        },
      }),
    () =>
      out({
        type: 'extension_ui_request',
        id: 'ext-widget-fleet',
        method: 'setWidget',
        widgetKey: 'subagent-async',
        widgetLines: [fleet],
      }),
    ...say('Reviewer found one nit; scout is mapping the auth flow in the background.'),
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled', aborted: false }),
    () => completion,
    // The run reports back: the widget goes, the muted completion lands, and
    // the model is woken to read it.
    () =>
      out({
        type: 'extension_ui_request',
        id: 'ext-widget-fleet-clear',
        method: 'setWidget',
        widgetKey: 'subagent-async',
      }),
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    () => out({ type: 'message_start', message: notify }),
    () => out({ type: 'message_end', message: notify }),
    // Pi's get_entries reads its in-memory branch, which holds the notice as
    // soon as it lands; an Inspect run link validates its run against it.
    () =>
      fs.appendFileSync(
        SESSION_FILE,
        JSON.stringify({
          type: 'custom_message',
          id: 'notify-scout',
          parentId: sessionEntries().at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          customType: notify.customType,
          content: notify.content,
          display: notify.display,
          details: notify.details,
        }) + '\n',
      ),
    ...say('Scout reports: the auth flow enters at login.ts.'),
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled', aborted: false }),
  ])
}

/**
 * Four pi-subagents children at once, in one foreground `parallel` call: a
 * scout that already reported and three still working, each on a different
 * tool. The run holds mid-flight until `/stub-finish-parallel`, so a test or
 * a screenshot sees every child live instead of racing the settle.
 */
function runParallelAgentsTurn() {
  const completion = new Promise((resolve) => {
    finishParallelAgents = resolve
  })
  const msg = { role: 'assistant', content: [] }
  const tasks = [
    { agent: 'scout', task: 'Find every caller of verifySession()' },
    { agent: 'worker', task: 'Move token refresh from login.ts into session.ts' },
    { agent: 'worker', task: 'Update the auth tests for the shared refresh path' },
    { agent: 'researcher', task: 'Check what RFC 9700 says about refresh-token rotation' },
  ]
  const scoutAnswer =
    '7 callers in 4 files. Two swallow a failed refresh: `middleware.ts:31` and `ws.ts:88`.'
  const live = [
    {
      status: 'completed',
      toolCount: 12,
      turnCount: 5,
      tokens: 18400,
      durationMs: 41000,
    },
    {
      status: 'running',
      currentTool: 'edit',
      currentToolArgs: 'src/auth/session.ts',
      recentTools: [
        { tool: 'read', args: 'src/auth/login.ts', endMs: 1 },
        { tool: 'read', args: 'src/auth/session.ts', endMs: 2 },
        { tool: 'grep', args: 'refreshToken src/', endMs: 3 },
      ],
      recentOutput: [
        'Moving refreshIfExpired() next to the session store so both callers share it.',
      ],
      toolCount: 9,
      turnCount: 4,
      tokens: 22300,
      durationMs: 58000,
    },
    {
      status: 'running',
      currentTool: 'bash',
      currentToolArgs: 'npm test -- src/auth',
      recentTools: [
        { tool: 'read', args: 'src/auth/login.test.ts', endMs: 1 },
        { tool: 'edit', args: 'src/auth/login.test.ts', endMs: 2 },
      ],
      recentOutput: [
        'Two tests asserted the old call order. Updating them, then running the suite.',
      ],
      toolCount: 7,
      turnCount: 3,
      tokens: 15800,
      durationMs: 52000,
    },
    {
      status: 'running',
      currentTool: 'fetch_content',
      currentToolArgs: 'rfc-editor.org/rfc/rfc9700',
      recentTools: [{ tool: 'web_search', args: 'RFC 9700 refresh token rotation', endMs: 1 }],
      recentOutput: [
        'Rotation is recommended for public clients; reusing an old token should revoke the family.',
      ],
      toolCount: 4,
      turnCount: 2,
      tokens: 9100,
      durationMs: 47000,
    },
  ]
  const details = (progress, results) => ({
    mode: 'parallel',
    results: tasks.map(({ agent, task }, index) => ({
      index,
      agent,
      task: '[prompt redacted]',
      sessionName: `${agent}: ${task}`,
      ...results(index),
    })),
    progress: tasks.map(({ agent }, index) => ({
      index,
      agent,
      task: '[prompt redacted]',
      recentTools: [],
      recentOutput: [],
      ...progress(index),
    })),
  })
  const say = (text) => [
    () => out({ type: 'message_start', message: msg }),
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
  const args = { tasks }

  play([
    () => out({ type: 'agent_start' }),
    () => out({ type: 'turn_start' }),
    () => out({ type: 'message_start', message: msg }),
    () =>
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Splitting this four ways: one agent maps the callers, two make the change, one checks the spec.',
            },
            { type: 'toolCall', id: 'sub_par', name: 'subagent', arguments: args },
          ],
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
      }),
    () => out({ type: 'tool_execution_start', toolCallId: 'sub_par', toolName: 'subagent', args }),
    () =>
      out({
        type: 'tool_execution_update',
        toolCallId: 'sub_par',
        toolName: 'subagent',
        partialResult: {
          content: [{ type: 'text', text: '4 agents running' }],
          details: details(
            (i) => (i === 0 ? { ...live[0], status: 'running', currentTool: 'grep' } : live[i]),
            () => ({}),
          ),
        },
      }),
    () =>
      out({
        type: 'tool_execution_update',
        toolCallId: 'sub_par',
        toolName: 'subagent',
        partialResult: {
          content: [{ type: 'text', text: '1 of 4 agents done' }],
          details: details(
            (i) => live[i],
            (i) => (i === 0 ? { exitCode: 0, finalOutput: scoutAnswer } : {}),
          ),
        },
      }),
    () => completion,
    () =>
      out({
        type: 'tool_execution_end',
        toolCallId: 'sub_par',
        toolName: 'subagent',
        isError: false,
        result: {
          content: [{ type: 'text', text: '4 agents finished' }],
          details: details(
            (i) => ({ ...live[i], status: 'completed', currentTool: undefined }),
            (i) => ({
              exitCode: 0,
              finalOutput: i === 0 ? scoutAnswer : `${tasks[i].agent} finished: ${tasks[i].task}.`,
            }),
          ),
        },
      }),
    ...say('All four reported. Refresh now lives in session.ts and the auth tests pass.'),
    () => out({ type: 'agent_end', messages: [] }),
    () => out({ type: 'agent_settled', aborted: false }),
  ])
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
  steps.push(() => out({ type: 'agent_settled', aborted: false }))
  play(steps, 4)
}
