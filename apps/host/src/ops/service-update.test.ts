import { expect, it, vi } from 'vitest'
import type { ProbeResult } from '../machine/probe'
import { stagedLine, stagedVersionIn, UP_TO_DATE } from '../commands/update'
import { runServiceUpdate, updaterSteps, type ServiceUpdateSteps } from './service-update'

const result = (stdout: string, code = 0): ProbeResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
})

function ports(steps: Partial<ServiceUpdateSteps>, pause: 'paused' | 'deadline' = 'paused') {
  const order: string[] = []
  const all: ServiceUpdateSteps = {
    stage: async () => (order.push('stage'), { kind: 'staged', version: '0.3.1' }),
    apply: async (v) => (order.push(`apply ${v}`), { ok: true }),
    ...steps,
  }
  const pauses = {
    begin: vi.fn(async () => (order.push('pause'), pause)),
    cancel: vi.fn(() => void order.push('cancel')),
  }
  return { ports: { steps: all, pauses }, order, pauses }
}

it('reads back exactly the version stage printed, and nothing else', () => {
  expect(stagedVersionIn(`fetching\n${stagedLine('0.3.1')}\n`)).toBe('0.3.1')
  expect(stagedVersionIn('Staged Host 0.3.1; apply it with: phosphor update --apply 0.3.2')).toBe(
    null,
  )
  expect(stagedVersionIn(UP_TO_DATE)).toBe(null)
})

it('stages, then applies the staged version, through the installed updater', async () => {
  const run = vi.fn(async (_file: string, args: readonly string[], _o: { env: object }) =>
    args.includes('--stage') ? result(`${stagedLine('0.3.1')}\n`) : result(''),
  )
  const steps = updaterSteps({ node: '/n', bundle: '/b.mjs', env: { A: '1' } }, run)
  expect(await steps.stage()).toEqual({ kind: 'staged', version: '0.3.1' })
  expect(await steps.apply('0.3.1')).toEqual({ ok: true })
  expect(run.mock.calls.map((c) => [c[0], c[1], c[2]?.env])).toEqual([
    ['/n', ['/b.mjs', 'update', '--stage'], { A: '1' }],
    ['/n', ['/b.mjs', 'update', '--apply', '0.3.1'], { A: '1' }],
  ])
  run.mockResolvedValueOnce(result(`${UP_TO_DATE}\n`))
  expect(await steps.stage()).toEqual({ kind: 'current' })
  run.mockResolvedValueOnce(result('nothing useful'))
  expect(await steps.stage()).toMatchObject({ kind: 'failed' })
  run.mockResolvedValueOnce(result('', 69))
  expect(await steps.stage()).toMatchObject({ kind: 'failed' })
})

it('stages, pauses every lane, then applies exactly the staged version', async () => {
  const h = ports({})
  expect(await runServiceUpdate(h.ports)).toMatchObject({ data: { outcome: 'applying' } })
  expect(h.order).toEqual(['stage', 'pause', 'apply 0.3.1'])
  expect(h.pauses.begin).toHaveBeenCalledWith('update')
})

it('applies nothing when lanes do not pause, or when it is already current', async () => {
  const late = ports({}, 'deadline')
  expect(await runServiceUpdate(late.ports)).toMatchObject({
    data: { outcome: 'not-paused', version: '0.3.1', pause: 'deadline' },
  })
  expect(late.order).toEqual(['stage', 'pause'])
  const current = ports({ stage: async () => ({ kind: 'current' }) })
  expect(await runServiceUpdate(current.ports)).toMatchObject({ data: { outcome: 'current' } })
  expect(current.pauses.begin).not.toHaveBeenCalled()
})

it('ends the pause when applying fails, and fails the job', async () => {
  const h = ports({ apply: async () => ({ ok: false, text: 'Applying 0.3.1 failed.' }) })
  await expect(runServiceUpdate(h.ports)).rejects.toThrow('Applying 0.3.1 failed.')
  expect(h.order).toEqual(['stage', 'pause', 'cancel'])
})
