import { describe, expect, it, vi } from 'vitest'
import { HOSTED_MAC, OWN_MAC, macRunner, pickMacRunner } from './mac-runner.mjs'

const labels = (...names: string[]) => names.map((name) => ({ name }))
const mac = (status: string, busy = false) => ({
  name: 'Mac',
  status,
  busy,
  labels: labels('self-hosted', 'macOS', 'ARM64'),
})
const linux = {
  name: 'phosphor-1',
  status: 'online',
  labels: labels('self-hosted', 'Linux', 'X64'),
}

describe('macRunner', () => {
  it('takes the project Mac when it is online, busy or not', () => {
    expect(macRunner([linux, mac('online')]).runsOn).toEqual(OWN_MAC)
    expect(macRunner([mac('online', true)]).runsOn).toEqual(OWN_MAC)
  })

  it('falls back to a GitHub Mac when the project Mac is offline or missing', () => {
    expect(macRunner([linux, mac('offline')])).toEqual({
      runsOn: HOSTED_MAC,
      reason: 'the project Mac is offline',
    })
    // An online Linux runner never stands in for the Mac.
    expect(macRunner([linux]).reason).toBe('no project Mac is registered')
    expect(macRunner(undefined).runsOn).toBe(HOSTED_MAC)
    expect(macRunner([{ status: 'online' }, null]).runsOn).toBe(HOSTED_MAC)
  })
})

describe('pickMacRunner', () => {
  const repository = 'agustinsacco/phosphor'
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it('asks the runners API with the status token', async () => {
    const request = reply(200, { runners: [mac('online')] })
    await expect(pickMacRunner({ token: 't', repository, request })).resolves.toMatchObject({
      runsOn: OWN_MAC,
    })
    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/repos/agustinsacco/phosphor/actions/runners?per_page=100',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer t' }) }),
    )
  })

  it('goes to a GitHub Mac on every doubt, without asking when it has no token', async () => {
    const request = reply(200, { runners: [mac('online')] })
    expect((await pickMacRunner({ token: '', repository, request })).runsOn).toBe(HOSTED_MAC)
    expect(request).not.toHaveBeenCalled()
    for (const failing of [
      reply(403, { message: 'Resource not accessible' }),
      vi.fn(async () => {
        throw new Error('network')
      }),
      reply(200, 'not json runners'),
    ])
      expect((await pickMacRunner({ token: 't', repository, request: failing })).runsOn).toBe(
        HOSTED_MAC,
      )
    for (const bad of ['../x', 'x/..', 'x', undefined])
      expect((await pickMacRunner({ token: 't', repository: bad, request })).runsOn).toBe(
        HOSTED_MAC,
      )
    expect(request).not.toHaveBeenCalled()
    expect((await pickMacRunner({ token: 't', repository: 'o/.github', request })).runsOn).toEqual(
      OWN_MAC,
    )
  })
})
