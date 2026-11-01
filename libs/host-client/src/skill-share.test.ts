import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { remoteSkillShare, SKILL_SHARE_ERRORS } from './skill-share'

type Result = Extract<HostFrame, { type: 'result' }>
let view: HostConnectionSnapshot
let generation: number
const call = vi.fn<(method: string, params: unknown) => Promise<Result>>()
const c = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  call,
}
let connected: typeof c | undefined
const share = remoteSkillShare(() => connected)
const bundle = { name: 'demo', files: [{ path: 'SKILL.md', data: btoa('hi') }] }
const ok = (data: unknown): Result => ({ type: 'result', id: 'x', ok: true, data })
const fail = (code: 'forbidden' | 'too-large' | 'unsupported' | 'bad-request'): Result => ({
  type: 'result',
  id: 'x',
  ok: false,
  error: { code, message: 'private Host text' },
})

beforeEach(() => {
  view = {
    connectionToken: 'test-connection-1',
    state: 'ready',
    capabilities: ['skills.read', 'machine.configure'],
    lanes: [],
    repositories: [],
  }
  generation = 1
  connected = c
  call.mockReset()
})

it('exports only a validated bundle with the requested name', async () => {
  call.mockResolvedValueOnce(ok(bundle))
  expect(await share.export('host', 'demo')).toEqual(bundle)
  expect(call).toHaveBeenCalledWith('skills.export', { name: 'demo' })
  call.mockResolvedValueOnce(ok({ ...bundle, name: 'other' }))
  await expect(share.export('host', 'demo')).rejects.toThrow('Not available')
  call.mockResolvedValueOnce(ok({ ...bundle, files: [{ path: '../x', data: '' }] }))
  await expect(share.export('host', 'demo')).rejects.toThrow('Not available')
  await expect(share.export('host', '../demo')).rejects.toThrow(SKILL_SHARE_ERRORS.refused)
})

it('installs only with configuration access and maps refusals to fixed text', async () => {
  call.mockResolvedValueOnce(ok({ status: 'conflict', replaceable: true }))
  expect(await share.install('host', bundle, false)).toEqual({
    status: 'conflict',
    replaceable: true,
  })
  expect(call).toHaveBeenCalledWith('skills.install', { bundle, overwrite: false })
  for (const [code, text] of [
    ['forbidden', SKILL_SHARE_ERRORS.configure],
    ['too-large', SKILL_SHARE_ERRORS.tooLarge],
    ['unsupported', SKILL_SHARE_ERRORS.outdated],
    ['bad-request', SKILL_SHARE_ERRORS.refused],
  ] as const) {
    call.mockResolvedValueOnce(fail(code))
    await expect(share.install('host', bundle, true)).rejects.toThrow(text)
  }
  view = { ...view, capabilities: ['skills.read'] }
  call.mockClear()
  await expect(share.install('host', bundle, false)).rejects.toThrow(SKILL_SHARE_ERRORS.configure)
  expect(call).not.toHaveBeenCalled()
})

it.each(['capability', 'connection', 'incarnation', 'throws', 'malformed'] as const)(
  'reports an install as unconfirmed when the %s changes or the reply is in doubt',
  async (change) => {
    call.mockImplementationOnce(async () => {
      if (change === 'capability') view = { ...view, capabilities: ['skills.read'] }
      if (change === 'connection') connected = { ...c }
      if (change === 'incarnation') generation++
      if (change === 'throws') throw new Error('socket closed')
      return ok(
        change === 'malformed' ? { status: 'done' } : { status: 'installed', replaced: false },
      )
    })
    await expect(share.install('host', bundle, false)).rejects.toThrow(
      SKILL_SHARE_ERRORS.unconfirmed,
    )
    expect(call).toHaveBeenCalledTimes(1)
  },
)
