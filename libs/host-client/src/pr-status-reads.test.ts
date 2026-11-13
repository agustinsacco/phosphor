import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { prKey } from '@phosphor/shared/github-pr-refs'
import { prStatusReads, routePrStatus } from './pr-status-reads'

const HOST = '00000000-0000-4000-8000-000000000001'
const MACHINE = `host:${HOST}`
const REF = { host: 'github.com', owner: 'acme', repo: 'app', number: 57 }
const KEY = prKey(REF)
const COVERAGE = { state: 'absent', checkedAt: 1, attemptedAt: 1 }
let view: HostConnectionSnapshot
let generation = 1
const call = vi.fn<(...args: unknown[]) => Promise<Extract<HostFrame, { type: 'result' }>>>()
const c = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  call,
}
let connected: typeof c | undefined
const reads = prStatusReads((hostId) => (hostId === HOST ? connected : undefined))
const answer = (data: unknown) => ({ type: 'result' as const, id: 'pr', ok: true as const, data })

beforeEach(() => {
  connected = c
  generation = 1
  view = {
    connectionToken: 'test',
    state: 'ready',
    prStatus: true,
    capabilities: ['workspaces.read'],
    lanes: [],
    repositories: [],
  }
  call.mockReset().mockResolvedValue(answer({ byKey: {}, coverage: { [KEY]: COVERAGE } }))
})

it('reads PR status by number through the named Host and parses the answer', async () => {
  expect(await reads.summaries([REF], { force: true }, MACHINE)).toEqual({
    byKey: {},
    coverage: { [KEY]: COVERAGE },
  })
  expect(call).toHaveBeenCalledExactlyOnceWith('github.prSummaries', {
    refs: [REF],
    options: { force: true },
  })
  call.mockResolvedValue(answer(null))
  expect(await reads.detail(REF, undefined, MACHINE)).toBeNull()
  expect(call).toHaveBeenLastCalledWith('github.prDetail', { ref: REF, options: {} })
})

it('answers null for a reply out of shape or about PRs nobody asked for', async () => {
  const other = { ...REF, number: 58 }
  call.mockResolvedValue(answer({ byKey: {}, coverage: { [prKey(other)]: COVERAGE } }))
  expect(await reads.summaries([REF], undefined, MACHINE)).toBeNull()
  call.mockResolvedValue(answer({ ref: other, threads: [] }))
  expect(await reads.detail(REF, undefined, MACHINE)).toBeNull()
})

it('never calls an older Host: no marker, or an unsupported answer, reads as unavailable', async () => {
  view = { ...view, prStatus: false }
  expect(await reads.summaries([REF], undefined, MACHINE)).toBeNull()
  expect(await reads.detail(REF, undefined, MACHINE)).toBeNull()
  expect(call).not.toHaveBeenCalled()
  view = { ...view, prStatus: true }
  call.mockResolvedValue({
    type: 'result',
    id: 'pr',
    ok: false,
    error: { code: 'unsupported', message: 'unsupported' },
  })
  expect(await reads.summaries([REF], undefined, MACHINE)).toBeNull()
})

it('refuses bad arguments and unknown or unready Hosts before calling', async () => {
  await expect(reads.summaries([], undefined, MACHINE)).rejects.toThrow('Not available')
  await expect(reads.summaries([REF], { machine: 1 }, MACHINE)).rejects.toThrow('Not available')
  await expect(reads.detail({ ...REF, x: 1 }, undefined, MACHINE)).rejects.toThrow('Not available')
  await expect(reads.summaries([REF], undefined, 'local')).rejects.toThrow('Not available')
  await expect(
    reads.summaries([REF], undefined, 'host:00000000-0000-4000-8000-000000000002'),
  ).rejects.toThrow('Not available')
  view = { ...view, capabilities: [] }
  await expect(reads.summaries([REF], undefined, MACHINE)).rejects.toThrow('Not available')
  expect(call).not.toHaveBeenCalled()
})

it('refuses an answer from a connection that changed while it was asked', async () => {
  call.mockImplementation(async () => {
    generation++
    return answer({ byKey: {}, coverage: {} })
  })
  await expect(reads.summaries([REF], undefined, MACHINE)).rejects.toThrow('Not available')
})

it('routes only PR reads that name a machine', async () => {
  expect(routePrStatus(reads, 'gh:prSummaries', [[REF]])).toBeNull()
  expect(routePrStatus(reads, 'gh:prDetail', [REF, undefined])).toBeNull()
  expect(routePrStatus(reads, 'gh:prsForRepo', ['host:x', undefined, MACHINE])).toBeNull()
  await routePrStatus(reads, 'gh:prSummaries', [[REF], undefined, MACHINE])!.result
  expect(call).toHaveBeenLastCalledWith('github.prSummaries', { refs: [REF], options: {} })
  await expect(
    routePrStatus(reads, 'gh:prDetail', [REF, undefined, 'local'])!.result,
  ).rejects.toThrow('Not available')
})
