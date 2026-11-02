import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReleaseStatus, quietReleaseRun, type ReleaseStatus } from './release-status'

const status = (extra: Partial<ReleaseStatus> = {}) =>
  JSON.stringify({
    version: 1,
    available: true,
    enabled: true,
    role: 'active',
    quiet: true,
    ...extra,
  })

describe('release status wire', () => {
  it('parses the payload and clamps free text', () => {
    expect(
      parseReleaseStatus(status({ holder: 'h'.repeat(200), epoch: 3, problem: 'p'.repeat(900) })),
    ).toEqual({
      version: 1,
      available: true,
      enabled: true,
      role: 'active',
      quiet: true,
      holder: 'h'.repeat(80),
      epoch: 3,
      problem: 'p'.repeat(300),
    })
  })

  it('rejects other versions, roles and malformed text', () => {
    expect(parseReleaseStatus(status({ version: 2 } as never))).toBeNull()
    expect(parseReleaseStatus(status({ role: 'leader' } as never))).toBeNull()
    expect(parseReleaseStatus(status({ quiet: 'yes' } as never))).toBeNull()
    expect(parseReleaseStatus('{')).toBeNull()
    expect(parseReleaseStatus(undefined)).toBeNull()
    expect(parseReleaseStatus('null')).toBeNull()
  })

  it('withholds an alert only for a quiet run in release mode', () => {
    expect(quietReleaseRun(status())).toBe(true)
    expect(quietReleaseRun(status({ quiet: false }))).toBe(false)
    expect(quietReleaseRun(status({ enabled: false }))).toBe(false)
    expect(quietReleaseRun(undefined)).toBe(false)
  })

  it('bundles for a browser or the Host without imports', async () => {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [resolve(import.meta.dirname, 'release-status.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
    })
    const inputs = Object.values(result.metafile.inputs)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.imports).toEqual([])
  })
})
