import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliContext } from '../cli-handlers'
import { createRunServices, runServiceFeatures } from './run-services'

afterEach(() => {
  vi.doUnmock('../ops/service')
  vi.resetModules()
})

const context = { nodeVersion: '22.22.3' } as CliContext
function capture() {
  let stdout = ''
  return {
    io: { stdout: (text: string) => void (stdout += text), stderr: () => {} },
    json: () => JSON.parse(stdout) as Record<string, unknown>,
  }
}

describe('run services', () => {
  it('announces Headroom but starts no machine services without a runtime', () => {
    expect(runServiceFeatures()).toEqual(['headroom'])
    expect(Object.values(createRunServices())).toEqual([null, null, null, null, null])
  })

  it('reports only built service features in version --json', async () => {
    const { handleVersion } = await import('../cli-handlers')
    const plain = capture()
    await handleVersion({ name: 'version', options: { json: true } }, plain.io, context)
    expect(plain.json()).toMatchObject({ features: ['headroom'] })
    vi.resetModules()
    vi.doMock('../ops/service', () => ({ createOpsService: () => null, FEATURE: 'ops' }))
    const fresh = await import('../cli-handlers')
    const built = capture()
    await fresh.handleVersion({ name: 'version', options: { json: true } }, built.io, context)
    expect(built.json()).toMatchObject({ features: ['ops', 'headroom'] })
  })
})
