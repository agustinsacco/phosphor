import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliContext } from '../cli-handlers'
import type * as Pause from '../lanes/pause'
import type * as Headroom from '../session/headroom'
import { createRunServices, runServiceFeatures } from './run-services'

afterEach(() => {
  vi.doUnmock('../ops/service')
  vi.doUnmock('../lanes/pause')
  vi.doUnmock('../session/headroom')
  vi.resetModules()
})

const context = { nodeVersion: '22.22.3' } as CliContext
/** The daemon-first machine: always built, whichever services are. */
const MACHINE = ['local-mode', 'owner-socket', 'owner-lock', 'migrate-v1']
const ALL = ['ops', 'machine-grants', 'headroom', 'app-services', 'service-pause', ...MACHINE]
function capture() {
  let stdout = ''
  return {
    io: { stdout: (text: string) => void (stdout += text), stderr: () => {} },
    json: () => JSON.parse(stdout) as Record<string, unknown>,
  }
}

describe('run services', () => {
  it('reports the built features, and builds the pause only with the lanes it pauses', () => {
    expect(runServiceFeatures()).toEqual(ALL)
    expect(Object.values(createRunServices())).toEqual([null, null, null, null, null])
  })

  it('reports each built service feature in version --json, in the service order', async () => {
    const { handleVersion } = await import('../cli-handlers')
    const plain = capture()
    await handleVersion({ name: 'version', options: { json: true } }, plain.io, context)
    expect(plain.json()).toMatchObject({ features: ALL })
    vi.resetModules()
    vi.doMock('../ops/service', () => ({ createOpsService: () => null, FEATURE: null }))
    const fresh = await import('../cli-handlers')
    const built = capture()
    await fresh.handleVersion({ name: 'version', options: { json: true } }, built.io, context)
    expect(built.json()).toMatchObject({ features: ALL.filter((f) => f !== 'ops') })
  })

  it('reports only the machine features while no service is built', async () => {
    vi.doMock('../lanes/pause', async (original) => ({
      ...(await original<typeof Pause>()),
      FEATURE: null,
    }))
    vi.doMock('../session/headroom', async (original) => ({
      ...(await original<typeof Headroom>()),
      FEATURE: null,
    }))
    const { handleVersion } = await import('../cli-handlers')
    const plain = capture()
    await handleVersion({ name: 'version', options: { json: true } }, plain.io, context)
    expect(plain.json()).toMatchObject({
      features: ['ops', 'machine-grants', 'app-services', ...MACHINE],
    })
  })
})
