import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLeases } from './lease'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'host-lease-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('takes every path or none, including descendants through a folder alias', async () => {
  const repo = join(root, 'repo'), alias = join(root, 'alias'), other = join(root, 'other')
  await mkdir(repo)
  await symlink(repo, alias)
  const leases = createWorkspaceLeases(() => [])
  const held = await leases.take('owner', [repo], 10000)
  expect(held).toHaveProperty('leaseId')
  await expect(leases.take('owner', [other, join(alias, 'missing')], 1000)).resolves.toEqual({ refused: 'busy', path: join(alias, 'missing') })
  const run = vi.fn(async () => {})
  await expect(leases.withUse(join(alias, 'missing'), 'routine', run)).rejects.toThrow('leased')
  expect(run).not.toHaveBeenCalled()
  await leases.withUse(other, 'archive', run)
  expect(run).toHaveBeenCalledOnce()
})

it('retains admission until an operation settles, and consults current live lanes at take', async () => {
  const live: {workspacePath:string}[] = []
  const leases = createWorkspaceLeases(() => live)
  let finish!: () => void
  const run = vi.fn(() => new Promise<void>(resolve => {finish = resolve}))
  const starting = leases.withUse(root, 'routine', run)
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  await expect(leases.take('owner', [root], 1000)).resolves.toEqual({refused:'routine',path:root})
  live.push({workspacePath:root})
  finish(); await starting
  await expect(leases.take('owner', [root], 1000)).resolves.toEqual({refused:'live-lane',path:root})
})

it('renews only an unexpired lease for its owner and releases idempotently', async () => {
  let now = 0
  const leases = createWorkspaceLeases(() => [], () => now)
  const take = async () => {
    const result = await leases.take('one', [root], 10)
    if (!('leaseId' in result)) throw new Error('lease refused')
    return result.leaseId
  }
  const id = await take(); now = 9
  expect(leases.renew('other', id)).toEqual({ok:false})
  leases.release('other', id)
  expect(leases.renew('one', id)).toEqual({ok:true})
  now = 10
  expect(await leases.take('two', [root], 10)).toHaveProperty('refused')
  now = 19
  expect(leases.renew('one', id)).toEqual({ok:false})
  const next = await take()
  expect(leases.release('one', next)).toEqual({ok:true})
  expect(leases.release('one', next)).toEqual({ok:true})
  expect(await take()).not.toBe(id)
})
