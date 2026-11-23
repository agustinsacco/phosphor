import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
    ['audit.undo', 'confirm.approve', 'confirm.deny', 'policy.set'].sort(),
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

it('has a stub file for every H1–H4 pending op, which serves nothing yet', () => {
  const owned = Object.values(PENDING_HANDLERS).filter((p) => /^H[1-4]$/.test(p.package))
  expect(new Set(owned.map((p) => p.package))).toEqual(new Set(['H4']))
  for (const { file } of owned) expect(existsSync(join(import.meta.dirname, file)), file).toBe(true)
})

it('serves machine.doctor through the login-shell refresh', async () => {
  let refreshed = 0
  const handlers = domainHandlers({
    ...deps,
    shellEnvironment: {
      refresh: async () => {
        refreshed++
        return true
      },
    } as unknown as DaemonHandlerDeps['shellEnvironment'],
  })
  const ctx = { principal: { kind: 'local', clientId: 'cli' } } as never
  expect(await handlers['machine.doctor']!({}, ctx)).toMatchObject({
    data: { shellEnvironment: 'refreshed' },
  })
  expect(refreshed).toBe(1)
  expect(await domainHandlers(deps)['machine.doctor']!({}, ctx)).toMatchObject({
    data: { shellEnvironment: 'not-used' },
  })
})

it('leaves cross-machine skill sharing to the app, not machine grants', () => {
  expect(OP_GAPS.daemon['skill.share']).toContain('share skills from the Phosphor app')
})
