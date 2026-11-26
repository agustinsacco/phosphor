import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OP_CATALOG, OP_GAPS } from '@phosphor/shared/ops-catalog'
import { builtinHandlers } from '@phosphor/session-runtime/ops/builtins'
import { daemonMetaHandlers } from './meta'
import { domainHandlers, PENDING_HANDLERS, type DaemonHandlerDeps } from './index'

const deps = { shellEnvironment: null, log: () => {} } as unknown as DaemonHandlerDeps
const served = {
  ...builtinHandlers({ policy: {} as never }, { confirms: {} as never }),
  ...daemonMetaHandlers({} as never),
  ...domainHandlers(deps),
}

/** Reconcile-v1 B8 minus N7 (`mcp.lane`, `artifact.remove`), plus reconcile-v2 #6's additions. */
const ALLOWED_GAPS =
  `lane.move git.fetch git.pull git.updateFromMain git.commitAll git.checkout git.renameBranch git.restoreFile git.merge
 worktree.add worktree.remove worktree.prune worktree.restore worktree.recreate files.search maintenance.scan maintenance.run
 skill.share brain.find brain.queue brain.status mcp.expose routine.check routine.fromLane git.branches git.worktrees git.diff`
    .trim()
    .split(/\s+/)

/** Ops the never tier refuses to every principal except the surface they are for. */
const surfaceOnlyNever = OP_CATALOG.filter((s) => s.tier === 'never' && s.surfaceOnly === true)

it('resolves every op the daemon may serve to a handler, a pending package, or a reviewed gap', () => {
  const unresolved = OP_CATALOG.filter(
    (spec) => spec.tier !== 'never' || spec.surfaceOnly === true,
  ).filter(
    (spec) =>
      !Object.hasOwn(served, spec.name) &&
      !Object.hasOwn(PENDING_HANDLERS, spec.name) &&
      !Object.hasOwn(OP_GAPS.daemon, spec.name),
  )
  expect(unresolved.map((spec) => spec.name)).toEqual([])
})

it('keeps the allowed gap list to reconcile B8 minus N7', () => {
  expect(Object.keys(OP_GAPS.daemon).sort()).toEqual([...ALLOWED_GAPS].sort())
  expect(ALLOWED_GAPS).not.toContain('mcp.lane')
  expect(ALLOWED_GAPS).not.toContain('artifact.remove')
})

it('serves the surface-only never ops: policy, Undo and the user’s confirmation answers', () => {
  expect(surfaceOnlyNever.map((s) => s.name).sort()).toEqual(
    ['audit.undo', 'confirm.approve', 'confirm.deny', 'policy.set', 'service.pause'].sort(),
  )
  for (const spec of surfaceOnlyNever) expect(served).toHaveProperty([spec.name])
})

it('lists a pending op once, never also served or a gap, and only for a catalog op', () => {
  const names = new Set(OP_CATALOG.map((s) => s.name))
  for (const [name, pending] of Object.entries(PENDING_HANDLERS)) {
    expect(names.has(name), name).toBe(true)
    expect(Object.hasOwn(served, name), `${name} is served`).toBe(false)
    expect(Object.hasOwn(OP_GAPS.daemon, name), `${name} is a gap`).toBe(false)
    expect(pending.file).toMatch(/^[a-z-]+\.ts$/)
  }
})

it('leaves no H1–H4 op pending', () => {
  const owned = Object.values(PENDING_HANDLERS).filter((p) => /^H[1-4]$/.test(p.package))
  expect(owned).toEqual([])
  for (const { file } of owned) expect(existsSync(join(import.meta.dirname, file)), file).toBe(true)
})

it('projects health without refreshing, and refreshes only on the configure op', async () => {
  let refreshed = 0
  const handlers = domainHandlers({
    ...deps,
    machineHealth: () => ({ pi: 'ready', control: 'not-enrolled' }),
    shellEnvironment: {
      status: () => ({ status: 'cached', ageMs: 42 }),
      refresh: async () => {
        refreshed++
        return true
      },
    } as unknown as DaemonHandlerDeps['shellEnvironment'],
  })
  const ctx = { principal: { kind: 'local', clientId: 'cli' } } as never
  expect(await handlers['machine.doctor']!({}, ctx)).toMatchObject({
    data: { pi: 'ready', control: 'not-enrolled', service: { kind: 'none' }, shellEnvironment: { status: 'cached', ageMs: 42 } },
  })
  expect(refreshed).toBe(0)
  expect(await handlers['machine.refreshEnvironment']!({}, ctx)).toMatchObject({ data: { shellEnvironment: 'refreshed' } })
  expect(refreshed).toBe(1)
  expect(await domainHandlers(deps)['machine.doctor']!({}, ctx)).toMatchObject({
    data: { shellEnvironment: { status: 'not-used' } },
  })
})

it('leaves cross-machine skill sharing to the app, not machine grants', () => {
  expect(OP_GAPS.daemon['skill.share']).toContain('share skills from the Phosphor app')
})

it('serves service.update as an asked background job that wraps the service updater', async () => {
  const ctx = { principal: { kind: 'local', clientId: 'cli' } } as never
  await expect(domainHandlers(deps)['service.update']!({}, ctx)).rejects.toMatchObject({
    code: 'unavailable',
  })
  const steps = {
    stage: async () => ({ kind: 'current' as const }),
    apply: async () => ({ ok: true as const }),
  }
  const pauses = { begin: async () => 'paused' as const, cancel: () => {} }
  const handlers = domainHandlers({ ...deps, serviceUpdate: { steps, pauses } })
  expect(await handlers['service.update']!({}, ctx)).toMatchObject({ data: { outcome: 'current' } })
  const spec = OP_CATALOG.find((s) => s.name === 'service.update')!
  expect(spec).toMatchObject({ tier: 'destructive', job: true })
})

it('reports the machine’s lanes, version and pause, and its inventory through the lane service', async () => {
  const ctx = { principal: { kind: 'local', clientId: 'cli' } } as never
  const call = vi.fn(async (method: string) => ({ ok: true, data: { method } }))
  const summaries: Record<string, { activity: string }> = {
    a: { activity: 'working' },
    b: { activity: 'idle' },
    c: { activity: 'stopped' },
  }
  const handlers = domainHandlers({
    ...deps,
    store: { listLanes: () => [{ laneId: 'a' }, { laneId: 'b' }, { laneId: 'c' }] },
    lanes: { calls: { call } },
    laneRuntime: { summaryFor: (id: string) => summaries[id] ?? null },
    pauseState: () => ({ kind: 'none' }),
  } as unknown as DaemonHandlerDeps)
  expect((await handlers['machine.status']!({}, ctx)).data).toMatchObject({
    lanes: { total: 3, live: 2, working: 1 },
    pause: { kind: 'none' },
  })
  await handlers['machine.models']!({}, ctx)
  expect(call.mock.calls).toEqual([
    ['machine.models', {}],
  ])
})

it('advertises service.pause and serves only a human action during a live pause', async () => {
  const pauseControl = vi.fn<(action: 'abort-now' | 'cancel') => boolean>(() => true)
  const handlers = domainHandlers({
    ...deps,
    pauseControl,
    store: { listLanes: () => [] } as never,
  })
  const surface = { principal: { kind: 'surface' } } as never
  const agent = { principal: { kind: 'agent' } } as never
  expect(await handlers['machine.status']!({}, surface)).toMatchObject({
    data: { update: { pauseControl: true } },
  })
  await expect(handlers['service.pause']!({ action: 'abort-now' }, agent)).rejects.toMatchObject({
    code: 'forbidden',
  })
  expect(pauseControl).not.toHaveBeenCalled()
  await handlers['service.pause']!({ action: 'abort-now' }, surface)
  await handlers['service.pause']!({ action: 'cancel' }, surface)
  expect(pauseControl.mock.calls).toEqual([['abort-now'], ['cancel']])
  pauseControl.mockReturnValue(false)
  await expect(handlers['service.pause']!({ action: 'cancel' }, surface)).rejects.toMatchObject({
    code: 'unavailable',
  })
})

it('reports the self-check and the last update in machine.status data.update', async () => {
  const surface = { principal: { kind: 'surface' } } as never
  const last = {
    from: '1.2.0',
    to: '1.3.0',
    outcome: 'rolled-back',
    at: '2026-11-26T11:00:00.000Z',
  }
  const report = vi.fn(() => ({
    supported: true,
    available: '1.3.0',
    checkedAt: '2026-11-26T12:00:00.000Z',
    last,
  }))
  const handlers = domainHandlers({
    ...deps,
    store: { listLanes: () => [] } as never,
    pauseControl: () => true,
    machineUpdate: { report, stop: () => {} },
  } as unknown as DaemonHandlerDeps)
  expect((await handlers['machine.status']!({}, surface)).data).toMatchObject({
    update: {
      supported: true,
      available: '1.3.0',
      checkedAt: '2026-11-26T12:00:00.000Z',
      pauseControl: true,
      last,
    },
  })
  expect(report).toHaveBeenCalledTimes(1)
  const plain = domainHandlers({ ...deps, store: { listLanes: () => [] } as never })
  expect((await plain['machine.status']!({}, surface)).data).not.toHaveProperty('update')
})
