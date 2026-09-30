/**
 * omp compatibility check: drives Phosphor's own main-process code (agent
 * selection, health, `PiRpcClient` and its omp dialect, the command probe and
 * `/` menu catalogue, the session scanner and tree reader) against a REAL
 * `omp --mode rpc`. No prompt is ever sent, so no model turn runs and no token
 * is spent.
 *
 * Run through `scripts/omp-compat.zsh`, which bundles this file. stdout gets
 * exactly one JSON line; every log goes to stderr.
 *
 * Isolation: omp runs with HOME and PI_CODING_AGENT_DIR pointed at a fresh
 * temp directory, holding an offline provider (`models.yml`, pointed at an
 * unroutable port) and one fixture skill. Nothing under the user's real
 * `~/.omp` or `~/.pi` is written. The session sidebar is checked against a
 * committed fixture (`electron/pi/__fixtures__/omp-session.jsonl`, shaped
 * from a real omp session's first lines), placed where omp itself says the
 * workspace's sessions live.
 *
 * Environment:
 *   OMP_COMPAT_BIN              explicit omp binary (default: found on PATH)
 *   OMP_COMPAT_TIMEOUT_MS       per-step timeout (default 30000)
 *   OMP_COMPAT_REAL_WORKSPACE   also list this workspace's sessions from the
 *                               real omp agent dir, read-only (scenario_03)
 *   OMP_COMPAT_REAL_AGENT_DIR   that agent dir (default ~/.omp/agent)
 *   OMP_COMPAT_EXPECT_TITLE     a title that real listing must contain
 *   OMP_COMPAT_KEEP=1           keep the temp directory for inspection
 *
 * scenario_03 also opens a generated session holding one message far over omp's
 * 1 MiB line cap, which only comes back whole over protocol v2 (chunked frames).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setActiveAgent } from '../electron/pi/agent'
import { BUNDLED_EXTENSION_FILES } from '../electron/pi/bundled-extensions'
import { probeCommands } from '../electron/pi/commands'
import { cachedAgentHealth } from '../electron/pi/health'
import { clearRealCwdCache, sessionDirForCwd } from '../electron/pi/pi-paths'
import { PiRpcClient } from '../electron/pi/rpc-client'
import { clearSessionCaches, listSessions } from '../electron/pi/session-scanner'
import { readSessionTree } from '../electron/pi/session-tree'
import { piProcessEnv, resetShellPathCache } from '../electron/pi/shell-env'
import { buildCommandEntries } from '../src/features/chat/composer/commandCatalogue'
import type { PiHealth } from '../shared/models'

// Nothing but the result line may reach stdout.
console.log = console.error
const say = (message: string): void => void process.stderr.write(`[omp-compat] ${message}\n`)

// The bundle lands outside the repo, so the zsh wrapper names the repo root.
const REPO = resolve(process.env.OMP_COMPAT_REPO ?? process.cwd())
const TIMEOUT_MS = Number(process.env.OMP_COMPAT_TIMEOUT_MS) || 30_000
const FIXTURE = join(REPO, 'electron/pi/__fixtures__/omp-session.jsonl')
const FIXTURE_SESSION_ID = '0190f000-0000-7000-8000-00000000c0de'
const FIXTURE_TITLE = 'Evaluating a GUI'
const SKILL = 'compat-probe'

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** A throwaway omp home: offline provider, one skill, one workspace. */
function makeSandbox(): { root: string; home: string; agentDir: string; workspace: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-compat-')))
  const home = join(root, 'home')
  const agentDir = join(home, '.omp', 'agent')
  const workspace = join(home, 'work', 'project')
  mkdirSync(join(agentDir, 'skills', SKILL), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  // Port 9 (discard) on loopback: a model that can never be reached, so even
  // a stray prompt could not spend anything.
  writeFileSync(
    join(agentDir, 'models.yml'),
    [
      'providers:',
      '  offline:',
      '    baseUrl: http://127.0.0.1:9/v1',
      '    auth: none',
      '    api: openai-completions',
      '    models:',
      '      - id: offline-model',
      '        name: Offline',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(agentDir, 'skills', SKILL, 'SKILL.md'),
    `---\nname: ${SKILL}\ndescription: Fixture skill for the omp compatibility check\n---\n\nBody.\n`,
  )
  return { root, home, agentDir, workspace }
}

/**
 * An omp session file around one very large user message, in the shape omp
 * writes (title slot, header, model change, messages).
 */
function largeSessionFile(id: string, cwd: string, text: string): string {
  const at = '2026-09-26T10:00:00.000Z'
  const lines = [
    {
      type: 'title',
      v: 1,
      title: 'Large session',
      source: 'auto',
      updatedAt: at,
      pad: ' '.repeat(64),
    },
    {
      type: 'session',
      version: 3,
      id,
      timestamp: at,
      cwd,
      title: 'Large session',
      titleSource: 'auto',
    },
    {
      type: 'model_change',
      id: 'aa000001',
      parentId: null,
      timestamp: at,
      model: 'offline/offline-model',
    },
    {
      type: 'message',
      id: 'aa000002',
      parentId: 'aa000001',
      timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1790400000000 },
    },
  ]
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

type ScenarioId = 'scenario_01' | 'scenario_02' | 'scenario_03'

async function main(): Promise<Record<ScenarioId, boolean>> {
  const results: Record<ScenarioId, boolean> = {
    scenario_01: false,
    scenario_02: false,
    scenario_03: false,
  }
  const realHome = homedir()
  const sandbox = makeSandbox()
  say(`sandbox ${sandbox.root}`)
  process.env.HOME = sandbox.home
  process.env.PI_CODING_AGENT_DIR = sandbox.agentDir
  clearRealCwdCache()
  resetShellPathCache()

  // Settings → Advanced → Agent = omp, exactly as main installs it.
  const agent = setActiveAgent({
    kind: 'omp',
    binaryPaths: { pi: '', omp: process.env.OMP_COMPAT_BIN ?? '' },
  })
  say(`agent ${JSON.stringify(agent)}`)

  let health: PiHealth | null = null
  let ompSessionFile: string | undefined
  const clients: PiRpcClient[] = []
  try {
    // scenario_01: an omp session starts when omp is the selected agent.
    try {
      health = await withTimeout(cachedAgentHealth(), 'health check')
      say(`health ${JSON.stringify({ ...health, message: undefined })}`)
      check(health.ok, `omp health failed: ${health.message ?? health.reason}`)
      check(health.agent === 'omp', `health describes ${health.agent}, not omp`)
      check(health.minVersion === undefined, 'a pi version floor was applied to omp')

      const client = new PiRpcClient({
        cwd: sandbox.workspace,
        agent: health.agent,
        ...(health.binaryPath ? { binaryPath: health.binaryPath } : {}),
        ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
        extensions: BUNDLED_EXTENSION_FILES.map((file) => join(REPO, 'pi-ext', file)),
        env: await piProcessEnv(),
      })
      clients.push(client)
      const extensionErrors: string[] = []
      client.on('event', (event) => {
        if (event.type === 'extension_error') {
          extensionErrors.push(`${event.extensionPath ?? '?'}: ${event.error}`)
        }
      })
      client.on('stderr', (text) => process.stderr.write(`[omp stderr] ${text}`))
      const ready = new Promise<void>((resolveReady) => client.once('ready', () => resolveReady()))
      client.spawn()
      await withTimeout(ready, 'omp ready frame')
      check(client.readyFrame?.type === 'ready', 'no ready frame recorded')
      say(`ready ${JSON.stringify(client.readyFrame)}`)

      const state = await withTimeout(client.request({ type: 'get_state' }), 'get_state')
      check(
        state.success && state.data,
        `get_state failed: ${state.success ? 'no data' : state.error}`,
      )
      check(typeof state.data.sessionId === 'string', 'get_state has no sessionId')
      check(
        Number.isInteger(state.data.pendingMessageCount),
        'get_state pendingMessageCount was not mapped from omp',
      )
      ompSessionFile = state.data.sessionFile
      say(`get_state sessionId=${state.data.sessionId} sessionFile=${ompSessionFile ?? '-'}`)
      // Extensions report load failures as events right after startup.
      await new Promise((r) => setTimeout(r, 1000))
      check(extensionErrors.length === 0, `extension errors: ${extensionErrors.join('; ')}`)
      results.scenario_01 = true
    } catch (error) {
      say(`scenario_01 failed: ${String(error)}`)
    }

    // scenario_02: the `/` menu lists omp commands and skills.
    try {
      check(health?.ok && health.binaryPath, 'omp is not available')
      const rows = await withTimeout(
        probeCommands({
          workspacePath: sandbox.workspace,
          agent: health.agent,
          binaryPath: health.binaryPath,
          ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
          env: await piProcessEnv(),
        }),
        'command probe',
      )
      const entries = buildCommandEntries(rows, [])
      const bySource: Record<string, number> = {}
      for (const entry of entries) bySource[entry.badge] = (bySource[entry.badge] ?? 0) + 1
      say(`menu ${entries.length} rows ${JSON.stringify(bySource)}`)
      const skill = entries.find((entry) => entry.name === `skill:${SKILL}`)
      check(skill?.badge === 'skill', `fixture skill /skill:${SKILL} missing from the menu`)
      const builtin = entries.find((entry) => entry.origin === 'built into omp')
      check(builtin, 'no omp builtin command in the menu')
      say(`skill row /${skill.name}; builtin row /${builtin.name}`)
      results.scenario_02 = true
    } catch (error) {
      say(`scenario_02 failed: ${String(error)}`)
    }

    // scenario_03: the workspace's existing omp sessions appear in the sidebar.
    try {
      const dir = sessionDirForCwd(sandbox.workspace)
      say(`session dir ${dir}`)
      // omp's own answer for where this workspace's sessions live.
      check(ompSessionFile, 'omp reported no session file to compare the directory against')
      check(
        dirname(ompSessionFile) === dir,
        `Phosphor scans ${dir} but omp writes ${dirname(ompSessionFile)}`,
      )
      mkdirSync(dir, { recursive: true })
      const fixturePath = join(dir, `2026-09-25T19-35-31-179Z_${FIXTURE_SESSION_ID}.jsonl`)
      writeFileSync(
        fixturePath,
        readFileSync(FIXTURE, 'utf8').replaceAll('__WORKSPACE__', sandbox.workspace),
      )
      clearSessionCaches()
      const metas = await listSessions(sandbox.workspace)
      const meta = metas.find((m) => m.sessionId === FIXTURE_SESSION_ID)
      check(meta, `fixture session missing from the sidebar (${metas.length} listed)`)
      check(meta.name === FIXTURE_TITLE, `sidebar title is ${JSON.stringify(meta.name)}`)
      check(meta.cwd === sandbox.workspace, `session cwd is ${meta.cwd}`)
      check(
        meta.userMessages === 1 && meta.assistantMessages === 1,
        `message counts ${meta.userMessages}/${meta.assistantMessages}`,
      )
      const tree = await readSessionTree(fixturePath)
      check(tree.sessionId === FIXTURE_SESSION_ID, 'tree read the wrong header')
      check(
        tree.entries.some((e) => e.type === 'session_info' && e.name === FIXTURE_TITLE),
        'title_change was not mapped for the tree',
      )
      check(
        tree.entries.some((e) => e.type === 'model_change' && e.provider === 'anthropic'),
        'model_change was not mapped for the tree',
      )
      say(`fixture listed: ${JSON.stringify(meta.name)}, tree ${tree.entries.length} entries`)

      // A long session: one message far past omp's 1 MiB line cap. On v1
      // omp answers its history with "RPC response exceeded the transport
      // limit"; the client must negotiate v2 and reassemble the chunks.
      // Generated here, never committed.
      check(health?.ok && health.binaryPath, 'omp is not available')
      const bigText = `${'long session line \u00e9\n'.repeat(80_000)}end`
      const bigId = randomUUID()
      const bigPath = join(dir, `2026-09-26T10-00-00-000Z_${bigId}.jsonl`)
      writeFileSync(bigPath, largeSessionFile(bigId, sandbox.workspace, bigText))
      say(`large fixture ${Buffer.byteLength(bigText)} bytes in one message`)
      const opened = new PiRpcClient({
        cwd: sandbox.workspace,
        agent: health.agent,
        binaryPath: health.binaryPath,
        ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
        sessionPath: bigPath,
        env: await piProcessEnv(),
      })
      clients.push(opened)
      opened.on('stderr', (text) => process.stderr.write(`[omp stderr] ${text}`))
      opened.spawn()
      const history = await withTimeout(opened.request({ type: 'get_messages' }), 'get_messages')
      check(
        history.success && history.data,
        `get_messages failed: ${history.success ? 'no data' : history.error}`,
      )
      const texts = history.data.messages.map((m) => JSON.stringify(m))
      check(
        texts.some((text) => text.includes(JSON.stringify(bigText).slice(1, -1))),
        `the ${Buffer.byteLength(bigText)}-byte message did not come back whole`,
      )
      say(
        `large session opened on protocol v${opened.protocolVersion}: ${history.data.messages.length} messages`,
      )

      const realWorkspace = process.env.OMP_COMPAT_REAL_WORKSPACE
      if (realWorkspace) {
        // Read-only: the scanner only stats and reads.
        process.env.HOME = realHome
        process.env.PI_CODING_AGENT_DIR =
          process.env.OMP_COMPAT_REAL_AGENT_DIR ?? join(realHome, '.omp', 'agent')
        clearRealCwdCache()
        clearSessionCaches()
        const real = await listSessions(realWorkspace)
        say(`real ${sessionDirForCwd(realWorkspace)}: ${real.length} sessions`)
        for (const m of real.slice(0, 10))
          say(`  ${m.createdAt} ${JSON.stringify(m.name ?? m.firstUserText ?? '')}`)
        check(real.length > 0, `no omp sessions found for ${realWorkspace}`)
        const expected = process.env.OMP_COMPAT_EXPECT_TITLE
        if (expected) {
          check(
            real.some((m) => m.name === expected),
            `no real session titled ${JSON.stringify(expected)}`,
          )
        }
      }
      results.scenario_03 = true
    } catch (error) {
      say(`scenario_03 failed: ${String(error)}`)
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.dispose()))
    if (process.env.OMP_COMPAT_KEEP === '1') say(`kept ${sandbox.root}`)
    else rmSync(sandbox.root, { recursive: true, force: true })
  }
  return results
}

function report(results: Record<ScenarioId, boolean>): never {
  const scenarios = (['scenario_01', 'scenario_02', 'scenario_03'] as const).map((id) => ({
    id,
    status: results[id] ? 'passed' : 'failed',
  }))
  process.stdout.write(JSON.stringify({ scenarios, version: 1 }) + '\n')
  process.exit(scenarios.every((s) => s.status === 'passed') ? 0 : 1)
}

main().then(report, (error: unknown) => {
  say(`aborted: ${String(error)}`)
  report({ scenario_01: false, scenario_02: false, scenario_03: false })
})
