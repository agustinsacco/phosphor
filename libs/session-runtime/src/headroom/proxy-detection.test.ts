import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProxyDetection, headroomVersion } from './proxy-detection'

function detectionRig(
  binaryPath: string | null = '/bin/headroom',
  version: string | null = '0.37.0',
) {
  const deps = {
    resolveBinaryImpl: vi.fn(async (): Promise<string | null> => binaryPath),
    versionImpl: vi.fn(async (): Promise<string | null> => version),
  }
  return { ...deps, detect: createProxyDetection(deps) }
}

describe('proxy detection cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
  })
  afterEach(() => vi.useRealTimers())

  it('caches successful detection until exactly five minutes after completion', async () => {
    const r = detectionRig()
    r.versionImpl.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2000)
      return '0.37.0'
    })
    const found = await r.detect()
    expect(found).toEqual({ binaryPath: '/bin/headroom', version: '0.37.0' })
    expect(r.resolveBinaryImpl).toHaveBeenCalledWith('headroom')
    expect(r.versionImpl).toHaveBeenCalledWith('/bin/headroom')
    vi.setSystemTime(Date.now() + 299_999)
    expect(await r.detect()).toBe(found)
    expect(r.resolveBinaryImpl).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + 1)
    await r.detect()
    expect(r.resolveBinaryImpl).toHaveBeenCalledTimes(2)
    expect(r.versionImpl).toHaveBeenCalledTimes(2)
  })

  it('caches a miss for five seconds without asking for a version, then finds an install', async () => {
    const r = detectionRig(null)
    const miss = await r.detect()
    expect(miss).toEqual({ binaryPath: null, version: null })
    expect(r.versionImpl).not.toHaveBeenCalled()
    r.resolveBinaryImpl.mockResolvedValue('/new/headroom')
    vi.setSystemTime(Date.now() + 4999)
    expect(await r.detect()).toBe(miss)
    vi.setSystemTime(Date.now() + 1)
    expect(await r.detect()).toEqual({ binaryPath: '/new/headroom', version: '0.37.0' })
    expect(r.resolveBinaryImpl).toHaveBeenCalledTimes(2)
  })

  it('uses the success TTL even when the version command yields no version', async () => {
    const r = detectionRig('/bin/headroom', null)
    const found = await r.detect()
    vi.setSystemTime(Date.now() + 5000)
    expect(await r.detect()).toBe(found)
    expect(found.version).toBeNull()
    expect(r.versionImpl).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + 295_000)
    await r.detect()
    expect(r.versionImpl).toHaveBeenCalledTimes(2)
  })

  it('does not cache a rejected resolution or injected version lookup', async () => {
    const r = detectionRig()
    r.resolveBinaryImpl.mockRejectedValueOnce(new Error('shell failed'))
    await expect(r.detect()).rejects.toThrow('shell failed')
    r.versionImpl.mockRejectedValueOnce(new Error('version failed'))
    await expect(r.detect()).rejects.toThrow('version failed')
    expect(await r.detect()).toEqual({ binaryPath: '/bin/headroom', version: '0.37.0' })
    expect(r.resolveBinaryImpl).toHaveBeenCalledTimes(3)
  })
})

describe('headroomVersion', () => {
  it('extracts the version from a successful --version command', async () => {
    expect(await headroomVersion(process.execPath)).toBe(process.versions.node)
  })

  it('returns null when executing the version command fails', async () => {
    expect(await headroomVersion('/nonexistent/phosphor-headroom-test')).toBeNull()
  })
})
