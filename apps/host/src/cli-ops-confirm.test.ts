import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { runCli, type CliContext } from './cli'
import { openLocalClient } from './local-client'

vi.mock('./local-client', () => ({ openLocalClient: vi.fn() }))
afterEach(() => vi.useRealTimers())
const ctx = { terminal: true } as CliContext
const argv = ['lane', 'delete', 'dead', '--json']
const confirmId = randomUUID(),
  digest = 'a'.repeat(64)
const ok = { status: 'ok', text: 'Deleted', applies: 'now' } as const
function ask() {
  const run = vi.fn<ReturnType<typeof openLocalClient>['run']>()
  const close = vi.fn()
  const io = { stdout: vi.fn(), stderr: vi.fn() }
  const runBrain = vi.fn<ReturnType<typeof openLocalClient>['runBrain']>()
  vi.mocked(openLocalClient).mockReturnValue({ run, runBrain, close })
  run.mockResolvedValueOnce({
    status: 'confirm',
    title: 'Delete lane?',
    message: 'One lane: dead',
    items: [],
    confirmId,
    digest,
    expiresAt: Date.now() + 3600000,
  })
  return { run, close, io }
}
it.each(['approved', 'denied', 'expired'])(
  'polls the creator’s confirmation and acts only on approval (%s)',
  async (state) => {
    const { run, close, io } = ask()
    run.mockResolvedValueOnce({ ...ok, data: { state } }).mockResolvedValueOnce(ok)
    expect(await runCli(argv, io, ctx)).toBe(
      state === 'approved' ? 0 : state === 'expired' ? 75 : 1,
    )
    expect(run.mock.calls.map(([r]) => r.argv)).toEqual([
      argv,
      ['confirm.status', confirmId],
      ...(state === 'approved' ? [argv] : []),
    ])
    if (state === 'approved') expect(run.mock.calls[2]![0].confirm).toEqual({ confirmId, digest })
    expect(io.stderr).toHaveBeenCalledWith(
      'Delete lane?\nOne lane: dead\nApprove in Phosphor: Settings → Agent → Pending approvals\n',
    )
    expect(io.stdout).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(io.stdout.mock.calls[0]![0]))).toMatchObject({
      status: state === 'approved' ? 'ok' : 'denied',
    })
    expect(close).toHaveBeenCalledOnce()
  },
)
it('times out a stuck status call at ten minutes and never redeems', async () => {
  vi.useFakeTimers()
  const { run, close, io } = ask()
  run.mockReturnValueOnce(new Promise<OpsRunResult>(() => {}))
  const done = runCli(argv, io, ctx)
  await vi.advanceTimersByTimeAsync(599999)
  expect(close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await done).toBe(75)
  expect(run).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
})
