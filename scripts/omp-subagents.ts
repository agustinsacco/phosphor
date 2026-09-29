/**
 * omp subagent check: drives Phosphor's own code (agent selection, health,
 * `PiRpcClient` and its omp dialect, the main-process event trim, the chat
 * store, reducer and sub-agent row model) through what omp's `task` tool puts
 * on the wire. No prompt ever reaches a real agent, so no model turn runs and
 * no token is spent.
 *
 *   scenario_01  a real `omp --mode rpc --no-session`, in a temp cwd, accepts
 *                the subagent subscription the client sends when it opens,
 *                and answers `get_subagents`
 *   scenario_02  recorded omp frames (a batch `task` spawning two scouts):
 *                one running card per subagent with its agent and current
 *                tool, and the same after a reopen, from `get_subagents`
 *   scenario_03  the same subagents settled: answer, tools, tokens, time
 *   scenario_04  a pi session's pi-subagents `subagent` call still produces
 *                the rows it always did, and pi is never asked about omp's
 *
 * Scenarios 2-4 replay `electron/pi/__fixtures__/omp-task-replay.json` and
 * `pi-subagent-replay.json` through `fake-omp.cjs` / `fake-pi.cjs`, which
 * gate subagent frames the way omp's `RpcSubagentRegistry` does.
 *
 * Run through `scripts/omp-subagents.zsh`, which bundles this file. stdout gets
 * exactly one JSON line; every log goes to stderr.
 *
 * Isolation: the real omp runs with HOME and PI_CODING_AGENT_DIR pointed at a
 * fresh temp directory holding an offline provider (`models.yml`, pointed at
 * an unroutable port). Nothing under the user's real `~/.omp` or `~/.pi` is
 * written.
 *
 * Environment:
 *   OMP_SUBAGENTS_BIN          explicit omp binary (default: found on PATH)
 *   OMP_SUBAGENTS_TIMEOUT_MS   per-step timeout (default 30000)
 *   OMP_SUBAGENTS_KEEP=1       keep the temp directory for inspection
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { trimForRenderer } from '../electron/ipc/event-trim'
import { setActiveAgent } from '../electron/pi/agent'
import { cachedAgentHealth } from '../electron/pi/health'
import { clearRealCwdCache } from '../electron/pi/pi-paths'
import { PiRpcClient, type PiSpawnOptions } from '../electron/pi/rpc-client'
import { piProcessEnv, resetShellPathCache } from '../electron/pi/shell-env'
import { ompFleet, type SubagentChild } from '../src/features/chat/subagentRuns'
import { isToolActive, ompTaskView, summarizeTool } from '../src/features/chat/tools/toolSummaries'
import { useChatStore } from '../src/stores/chat'
import type { AgentMessage, PiEvent } from '../shared/rpc'

// Nothing but the result line may reach stdout.
console.log = console.error
const say = (message: string): void => void process.stderr.write(`[omp-subagents] ${message}\n`)

// The bundle lands outside the repo, so the zsh wrapper names the repo root.
const REPO = resolve(process.env.OMP_SUBAGENTS_REPO ?? process.cwd())
const TIMEOUT_MS = Number(process.env.OMP_SUBAGENTS_TIMEOUT_MS) || 30_000
const FIXTURES = join(REPO, 'electron/pi/__fixtures__')
const TASK_CALL = 'toolu_01TaskScouts'
const PI_CALL = 'call_subagent_1'

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

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${what}: got ${a}, expected ${e}`)
}

/** The first event of `type` the client emits. */
function nextEvent(client: PiRpcClient, type: PiEvent['type']): Promise<PiEvent> {
  return new Promise((resolveEvent) => {
    const listener = (event: PiEvent): void => {
      if (event.type !== type) return
      client.off('event', listener)
      resolveEvent(event)
    }
    client.on('event', listener)
  })
}

/** A throwaway omp home with an offline provider, and an empty workspace. */
function makeSandbox(): { root: string; home: string; agentDir: string; workspace: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-subagents-')))
  const home = join(root, 'home')
  const agentDir = join(home, '.omp', 'agent')
  const workspace = join(root, 'workspace')
  mkdirSync(agentDir, { recursive: true })
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
  return { root, home, agentDir, workspace }
}

/**
 * A client whose stream lands in the chat store the way a session view's
 * does: events trimmed as main pushes them, subagent frames onto their call.
 */
function watchedClient(options: PiSpawnOptions, sessionId: string): PiRpcClient {
  const client = new PiRpcClient(options)
  useChatStore.getState().ensure(sessionId)
  client.on('event', (event) =>
    useChatStore.getState().applyEvent(sessionId, trimForRenderer(event)),
  )
  client.on('subagent', (frame) => useChatStore.getState().applySubagentFrame(sessionId, frame))
  client.on('stderr', (text) => process.stderr.write(`[agent stderr] ${text}`))
  return client
}

function toolOf(sessionId: string, callId: string) {
  const tool = useChatStore.getState().sessions[sessionId]?.tools[callId]
  check(tool, `no tool ${callId} in session ${sessionId}`)
  return tool
}

function cardsOf(sessionId: string, callId: string): SubagentChild[] {
  const view = ompTaskView(toolOf(sessionId, callId))
  check(view, `the ${callId} task call fell back to the generic row`)
  return view.run.children
}

type ScenarioId = 'scenario_01' | 'scenario_02' | 'scenario_03' | 'scenario_04'
const SCENARIOS: ScenarioId[] = ['scenario_01', 'scenario_02', 'scenario_03', 'scenario_04']

async function main(): Promise<Record<ScenarioId, boolean>> {
  const results: Record<ScenarioId, boolean> = {
    scenario_01: false,
    scenario_02: false,
    scenario_03: false,
    scenario_04: false,
  }
  const sandbox = makeSandbox()
  say(`sandbox ${sandbox.root}`)
  process.env.HOME = sandbox.home
  process.env.PI_CODING_AGENT_DIR = sandbox.agentDir
  clearRealCwdCache()
  resetShellPathCache()
  const clients: PiRpcClient[] = []
  try {
    // scenario_01: opening an omp session subscribes to subagent progress.
    try {
      setActiveAgent({
        kind: 'omp',
        binaryPaths: { pi: '', omp: process.env.OMP_SUBAGENTS_BIN ?? '' },
      })
      const health = await withTimeout(cachedAgentHealth(), 'health check')
      check(health.ok, `omp health failed: ${health.message ?? health.reason}`)
      check(health.agent === 'omp', `health describes ${health.agent}, not omp`)
      say(`omp ${health.version ?? '?'} at ${health.binaryPath ?? '?'}`)
      const client = watchedClient(
        {
          cwd: sandbox.workspace,
          agent: 'omp',
          noSession: true,
          ...(health.binaryPath ? { binaryPath: health.binaryPath } : {}),
          ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
          env: await piProcessEnv(),
        },
        'real-omp',
      )
      clients.push(client)
      const turns: string[] = []
      client.on('event', (event) => {
        if (event.type === 'agent_start' || event.type === 'turn_start') turns.push(event.type)
      })
      const ready = new Promise<void>((resolveReady) => client.once('ready', () => resolveReady()))
      client.spawn()
      await withTimeout(ready, 'omp ready frame')
      // omp serializes commands, and the subscription is written ahead of
      // anything queued, so its answer is in by the time this one is.
      const running = await withTimeout(client.getSubagents(), 'get_subagents')
      check(Array.isArray(running), 'get_subagents gave no list')
      same(running.length, 0, 'subagents running in a fresh session')
      same(client.subagentSubscription, 'progress', 'subscription level omp confirmed')
      same(turns, [], 'agent turns started')
      say(`omp confirmed level ${client.subagentSubscription}; get_subagents answered []`)
      results.scenario_01 = true
    } catch (error) {
      say(`scenario_01 failed: ${String(error)}`)
    }

    // scenario_02 / 03: recorded omp frames through the client and row model.
    const omp = watchedClient(
      {
        cwd: sandbox.workspace,
        agent: 'omp',
        binaryPath: process.execPath,
        prefixArgs: [join(FIXTURES, 'fake-omp.cjs')],
        env: { FAKE_OMP_REPLAY: join(FIXTURES, 'omp-task-replay.json') },
      },
      'omp-live',
    )
    clients.push(omp)
    omp.spawn()
    try {
      const ended = nextEvent(omp, 'agent_end')
      await withTimeout(omp.request({ type: 'prompt', message: 'send two scouts' }), 'prompt')
      await withTimeout(ended, 'first turn')
      const tool = toolOf('omp-live', TASK_CALL)
      check(isToolActive(tool), 'the task row does not read as running')
      const cards = cardsOf('omp-live', TASK_CALL)
      const rows = cards.map(({ agent, label, status, currentTool }) => ({
        agent,
        label,
        status,
        currentTool,
      }))
      same(
        rows,
        [
          {
            agent: 'scout',
            label: 'ListElectron',
            status: 'running',
            currentTool: 'read electron',
          },
          { agent: 'scout', label: 'ListSrc', status: 'running', currentTool: 'find src/*' },
        ],
        'running cards',
      )
      same(
        summarizeTool(tool),
        { label: 'Delegating to', object: 'scout', hint: '0/2 done' },
        'running row',
      )
      same(
        ompFleet(Object.values(useChatStore.getState().sessions['omp-live']!.tools))?.active,
        2,
        'agent chip',
      )
      say(`running: ${JSON.stringify(rows)}`)

      // Reopened onto the same process: history from disk, then get_subagents.
      const history = await withTimeout(omp.request({ type: 'get_messages' }), 'get_messages')
      check(history.success && history.data, 'get_messages failed')
      useChatStore.getState().hydrate('omp-reopened', history.data.messages as AgentMessage[])
      const snapshots = await withTimeout(omp.getSubagents(), 'get_subagents')
      same(
        snapshots.map((s) => s.id),
        ['ListElectron', 'ListSrc'],
        'get_subagents ids',
      )
      useChatStore.getState().restoreSubagents('omp-reopened', snapshots)
      same(
        cardsOf('omp-reopened', TASK_CALL).map((c) => [c.status, c.currentTool]),
        [
          ['running', 'read electron'],
          ['running', 'find src/*'],
        ],
        'restored cards',
      )
      results.scenario_02 = true
    } catch (error) {
      say(`scenario_02 failed: ${String(error)}`)
    }

    try {
      const settled = nextEvent(omp, 'agent_settled')
      await withTimeout(omp.request({ type: 'prompt', message: 'continue' }), 'prompt')
      await withTimeout(settled, 'second turn')
      const tool = toolOf('omp-live', TASK_CALL)
      check(!isToolActive(tool), 'the task row still reads as running')
      const cards = cardsOf('omp-live', TASK_CALL)
      same(
        cards.map(({ status, toolCount, tokens, durationMs }) => ({
          status,
          toolCount,
          tokens,
          durationMs,
        })),
        [
          { status: 'completed', toolCount: 3, tokens: 8421, durationMs: 12400 },
          { status: 'completed', toolCount: 2, tokens: 6130, durationMs: 9800 },
        ],
        'settled cards',
      )
      check(
        cards[0]!.output?.startsWith('electron/ holds the main process') &&
          cards[1]!.output?.startsWith('src/ holds the renderer'),
        `settled answers: ${JSON.stringify(cards.map((c) => c.output))}`,
      )
      same(
        summarizeTool(tool),
        { label: 'Delegated to', object: 'scout', hint: '2 agents' },
        'settled row',
      )
      same(await withTimeout(omp.getSubagents(), 'get_subagents'), [], 'still running')
      say(
        `settled: ${JSON.stringify(cards.map((c) => [c.agent, c.toolCount, c.tokens, c.durationMs]))}`,
      )
      results.scenario_03 = true
    } catch (error) {
      say(`scenario_03 failed: ${String(error)}`)
    }

    // scenario_04: pi-subagents on pi, as before.
    try {
      const pi = watchedClient(
        {
          cwd: sandbox.workspace,
          binaryPath: process.execPath,
          prefixArgs: [join(FIXTURES, 'fake-pi.cjs')],
          env: { FAKE_PI_REPLAY: join(FIXTURES, 'pi-subagent-replay.json') },
        },
        'pi',
      )
      clients.push(pi)
      const frames: unknown[] = []
      pi.on('subagent', (frame) => frames.push(frame))
      let runningRow: unknown
      pi.on('event', (event) => {
        if (event.type === 'tool_execution_update')
          runningRow = summarizeTool(toolOf('pi', PI_CALL))
      })
      pi.spawn()
      const settled = nextEvent(pi, 'agent_settled')
      await withTimeout(pi.request({ type: 'prompt', message: 'review' }), 'prompt')
      await withTimeout(settled, 'pi turn')
      // The rows src/features/chat/subagentRuns.test.ts pins for these payloads.
      same(
        runningRow,
        { label: 'Delegating to', object: 'reviewer', hint: 'read src/auth.ts · 3 tools' },
        'running pi row',
      )
      same(
        summarizeTool(toolOf('pi', PI_CALL)),
        { label: 'Delegated to', object: 'reviewer', hint: '44 tools · 80.0k tokens · 4m 27s' },
        'settled pi row',
      )
      same(await withTimeout(pi.getSubagents(), 'getSubagents'), [], 'pi subagents')
      const state = await withTimeout(pi.request({ type: 'get_state' }), 'get_state')
      const received = state.success
        ? (state.data as unknown as { received?: string[] }).received
        : undefined
      same(received, ['prompt', 'get_state'], 'commands pi received')
      same(pi.subagentSubscription, undefined, 'pi subscription')
      same(frames, [], 'subagent frames from pi')
      results.scenario_04 = true
    } catch (error) {
      say(`scenario_04 failed: ${String(error)}`)
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.dispose()))
    if (process.env.OMP_SUBAGENTS_KEEP === '1') say(`kept ${sandbox.root}`)
    else rmSync(sandbox.root, { recursive: true, force: true })
  }
  return results
}

function report(results: Record<ScenarioId, boolean>): never {
  const scenarios = SCENARIOS.map((id) => ({ id, status: results[id] ? 'passed' : 'failed' }))
  process.stdout.write(JSON.stringify({ scenarios, version: 1 }) + '\n')
  process.exit(scenarios.every((s) => s.status === 'passed') ? 0 : 1)
}

main().then(report, (error: unknown) => {
  say(`aborted: ${String(error)}`)
  report({ scenario_01: false, scenario_02: false, scenario_03: false, scenario_04: false })
})
