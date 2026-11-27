import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isBrainOwnLane } from '@phosphor/brain-runtime/agent/own-lane'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSIONS_ROOT } from '../../__fixtures__/machine'
import type { BrainSurfaceAuthority } from '../../api/brain-adapter'
import { createHostLog } from '../../machine/log'
import { createHostRuntime, type HostRuntime } from '../../session/runtime'
import { createBrainCuratorContribution } from './curator-contribution'
import { createHostBrainAgentLane, type HostBrainAgentLane } from './lane'
import { createBrainAgentLaunchProfile } from './profile'
import { hostBrainAgentReservation } from './reservation'

const FAKE_PI = join(import.meta.dirname, '../../__fixtures__/fake-pi.cjs')

let dir: string
let state: string
let agentDir: string
let runtimes: HostRuntime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-brain-agent-'))
  state = join(dir, 'state')
  agentDir = join(dir, 'agent')
  mkdirSync(join(dir, 'harbor'), { recursive: true })
  mkdirSync(state)
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(async () => {
  for (const runtime of runtimes) {
    const draining = runtime.drain('test over')
    void runtime.drain('test over, hurried')
    await draining
  }
  runtimes = []
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A Host on the fake pi with Brain Agent's lane composed as run would compose it. */
function boot(): { runtime: HostRuntime; agent: HostBrainAgentLane } {
  // The fake pi lists the guard's command when it is loaded with it, as pi does.
  const guard = join(dir, 'brain-agent-guard.mjs')
  writeFileSync(guard, 'export default () => {}\n')
  // Synthetic: the fake pi stands in for a qualified launch; no production launch qualifies.
  const profile = createBrainAgentLaunchProfile(guard, { matches: () => true })
  const lane = hostBrainAgentReservation(state)
  const runtime = createHostRuntime(
    {
      brainCurator: createBrainCuratorContribution(lane, async () => undefined, profile),
      pi: { binaryPath: process.execPath, prefixArgs: [FAKE_PI] },
      env: { PATH: process.env.PATH!, HOME: dir, PI_CODING_AGENT_DIR: agentDir },
      roots: [join(dir, 'harbor')],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      machineContext: { kind: 'host', label: 'Harbor', os: 'Linux', repositories: [] },
      log: createHostLog(join(dir, 'logs'), []),
    },
    { dialogs: 'forward' },
  )
  runtimes.push(runtime)
  runtime.life.to('validating')
  runtime.life.to('ready')
  const agent = createHostBrainAgentLane({
    runtime,
    lane,
    profile,
    sessionsRoot: join(agentDir, 'sessions'),
    log: () => {},
  })
  return { runtime, agent }
}

function client(label: string, admitted = () => true): BrainSurfaceAuthority {
  return {
    client: { id: randomUUID(), label } as BrainSurfaceAuthority['client'],
    connectionId: randomUUID(),
    admit: admitted,
  }
}

async function until<T>(find: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const found = await find()
    if (found) return found
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const binding = () =>
  JSON.parse(readFileSync(join(state, 'brain', 'agent-lane.json'), 'utf8')) as {
    ref: string
    sessionFile: string
    fence: number
  }

describe('the Host’s Brain Agent lane', { timeout: 30_000 }, () => {
  it('lets the first sender take control, fences everyone else and shows only text', async () => {
    const { runtime, agent } = boot()
    const rina = client('Rina Okafor')
    const tom = client('Tom Lee')
    const empty = await agent.surface.show(null, rina)
    expect(empty).toMatchObject({ entries: [], controller: null, running: false, fence: 1 })
    expect(await agent.surface.send('Who owns Ledger? PHX-ledger', 1, rina)).toBe('ok')
    const page = await until(async () => {
      const shown = await agent.surface.show(null, tom)
      return shown.entries.length === 2 && shown
    }, 'the reply')
    expect(page.entries.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'Who owns Ledger? PHX-ledger'],
      ['assistant', 'PHX-ledger'],
    ])
    expect(page.controller).toEqual({ clientId: rina.client.id, label: 'Rina Okafor' })
    expect(page.fence).toBe(2)
    // No path, transcript or folder leaves the Host.
    expect(JSON.stringify(page)).not.toContain(dir)
    expect(await agent.surface.send('Tom here', 2, tom)).toBe('not-controller')
    expect(await agent.surface.send('stale', 1, rina)).toBe('not-controller')
    expect(await agent.surface.take(1, tom)).toBe('not-controller')
    expect(await agent.surface.take(2, tom)).toBe('ok')
    expect(await agent.surface.send('Rina again', 2, rina)).toBe('not-controller')
    expect(await agent.surface.stop(3, 'no-turn', rina)).toBe('not-controller')
    expect(binding().fence).toBe(3)
    // The reserved process is on no ordinary route.
    expect(runtime.list()).toEqual([])
  })

  it('refuses a caller whose authority lapsed before the message goes', async () => {
    const { agent } = boot()
    let allowed = true
    const mara = client('Mara Voss', () => allowed)
    expect(await agent.surface.take(1, mara)).toBe('ok')
    allowed = false
    expect(await agent.surface.send('Kestrel ships Friday', 2, mara)).toBe('unavailable')
    allowed = true
    expect((await agent.surface.show(null, mara)).entries).toEqual([])
  })

  it('never interrupts a running turn, and Stop ends only the turn that runs', async () => {
    const { agent } = boot()
    const rina = client('Rina Okafor')
    expect(await agent.surface.send('stream Northwind', 1, rina)).toBe('ok')
    await until(async () => (await agent.surface.show(null, rina)).running, 'the turn')
    expect(await agent.surface.send('and Harbor?', 2, rina)).toBe('busy')
    expect(await agent.surface.tell('Tom Lee leads Ledger', rina)).toBe('busy')
    // The reply in flight shows before it settles.
    await until(async () => {
      const { entries } = await agent.surface.show(null, rina)
      return entries.at(-1)?.role === 'assistant' && /^1\b/.test(entries.at(-1)!.text)
    }, 'the streamed reply')
    const { turn } = await agent.surface.show(null, rina)
    expect(await agent.surface.stop(2, turn!, rina)).toBe('ok')
    await until(async () => !(await agent.surface.show(null, rina)).running, 'the stop')
    // The stopped turn is no longer there to stop, and the next message is a new turn.
    expect(await agent.surface.stop(2, turn!, rina)).toBe('stale')
    expect(await agent.surface.send('PHX-after', 2, rina)).toBe('ok')
    await until(
      async () => (await agent.surface.show(null, rina)).entries.at(-1)?.text === 'PHX-after',
      'the next reply',
    )
  })

  it('keeps a question open until the controller answers it, never answering itself', async () => {
    const { agent } = boot()
    const rina = client('Rina Okafor')
    const tom = client('Tom Lee')
    const sent = agent.surface.send('Check with me first FAKE_ASK', 1, rina)
    const asked = await until(async () => {
      const shown = await agent.surface.show(null, rina)
      return shown.dialogs[0]
    }, 'the question')
    await sleep(200)
    expect((await agent.surface.show(null, rina)).dialogs.map((d) => d.id)).toEqual([asked.id])
    // Only the person whose turn asked sees it as theirs to answer.
    expect((await agent.surface.show(null, tom)).dialogs).toEqual([])
    const yes = { type: 'extension_ui_response' as const, id: asked.id, confirmed: true }
    expect(await agent.surface.answer(yes, 2, tom)).toBe('not-controller')
    expect(await agent.surface.answer({ ...yes, id: randomUUID() }, 2, rina)).toBe('not-found')
    expect(
      await agent.surface.answer(
        { type: 'extension_ui_response', id: asked.id, value: 'x' },
        2,
        rina,
      ),
    ).toBe('unavailable')
    expect(await agent.surface.answer(yes, 2, rina)).toBe('ok')
    expect(await sent).toBe('ok')
    expect((await agent.surface.show(null, rina)).dialogs).toEqual([])
  })

  it('runs Defrag on the same transcript in its own process, and its Stop spares the owner’s turn', async () => {
    const { agent } = boot()
    const rina = client('Rina Okafor')
    expect(await agent.surface.send('stream Harbor', 1, rina)).toBe('ok')
    await until(async () => (await agent.surface.show(null, rina)).running, 'the owner’s turn')
    const defrag = new AbortController()
    const hooks = { opened: vi.fn(), sending: vi.fn() }
    const turn = agent.host.turn('Defrag. 1 waiting.', defrag.signal, hooks)
    // Defrag waits for the owner's guarded turn before it restarts the lane in its profile.
    await sleep(300)
    expect(hooks.opened).not.toHaveBeenCalled()
    defrag.abort()
    expect(await turn).toMatchObject({ outcome: 'stopped' })
    expect(hooks.sending).not.toHaveBeenCalled()
    // The owner's turn still runs.
    const owner = await agent.surface.show(null, rina)
    expect(owner.running).toBe(true)
    expect(await agent.surface.stop(2, owner.turn!, rina)).toBe('ok')
    await until(async () => !(await agent.surface.show(null, rina)).running, 'the owner’s stop')
    const finished = await agent.host.turn('Defrag. PHX-defrag', new AbortController().signal, {
      opened: () => {},
      sending: () => {},
    })
    expect(finished).toMatchObject({ outcome: 'finished', sessionPath: binding().sessionFile })
    expect(isBrainOwnLane(agent.folder, agent.host.folder)).toBe(true)
  })

  it('keeps its ref and transcript across a restart and shows stopped history', async () => {
    const first = boot()
    const rina = client('Rina Okafor')
    expect(await first.agent.surface.send('PHX-before', 1, rina)).toBe('ok')
    await until(
      async () => (await first.agent.surface.show(null, rina)).entries.length === 2,
      'the reply',
    )
    const before = binding()
    await first.runtime.drain('restart')
    const second = boot()
    const stopped = await second.agent.surface.show(null, rina)
    expect(stopped.entries.map((e) => e.text)).toEqual(['PHX-before', 'PHX-before'])
    // A fresh process: nobody controls it, and the fence carries on from the binding.
    expect(stopped).toMatchObject({ controller: null, running: false, fence: before.fence })
    expect(await second.agent.surface.send('PHX-after', before.fence, rina)).toBe('ok')
    await until(
      async () => (await second.agent.surface.show(null, rina)).entries.length === 4,
      'the resumed reply',
    )
    expect(binding()).toMatchObject({ ref: before.ref, sessionFile: before.sessionFile })
  })

  it('pages history backwards by a Host-issued cursor', async () => {
    const { agent } = boot()
    const rina = client('Rina Okafor')
    for (let i = 0; i < 21; i++) {
      expect(await agent.surface.send(`PHX-m${i}`, i === 0 ? 1 : 2, rina)).toBe('ok')
      await until(async () => {
        const { entries, running } = await agent.surface.show(null, rina)
        return (
          !running && entries.at(-1)?.role === 'assistant' && entries.at(-1)?.text === `PHX-m${i}`
        )
      }, 'a reply')
    }
    const newest = await agent.surface.show(null, rina)
    expect(newest.entries).toHaveLength(40)
    expect(newest.next).toBe('b2')
    const older = await agent.surface.watch(newest.next, rina)
    expect(older.entries.map((e) => e.text)).toEqual(['PHX-m0', 'PHX-m0'])
    expect(older.next).toBeNull()
    await expect(agent.surface.show('/etc/passwd', rina)).rejects.toThrow()
  })
})
