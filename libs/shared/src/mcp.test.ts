import { describe, expect, it } from 'vitest'
import { exposesDirectTools, exposureSummary, isMcpOverride, mcpNamespace } from './mcp'

describe('exposureSummary', () => {
  it('says nothing at pi’s default', () => {
    expect(exposureSummary({ url: 'https://x.test' })).toBeNull()
    expect(exposureSummary({ url: 'https://x.test', exposure: 'codemode' })).toBeNull()
  })

  it('names the exposure and counts per-tool rules', () => {
    expect(exposureSummary({ command: 'x', exposure: 'direct' })).toBe('direct')
    expect(exposureSummary({ command: 'x', toolExposure: { a: 'direct' } })).toBe(
      'codemode +1 tool rule',
    )
    expect(
      exposureSummary({
        command: 'x',
        exposure: 'hidden',
        toolExposure: { a: 'direct', b: 'codemode' },
      }),
    ).toBe('hidden +2 tool rules')
  })
})

describe('exposesDirectTools', () => {
  it('is true when any tool is declared on every request', () => {
    expect(exposesDirectTools({ command: 'x' })).toBe(false)
    expect(exposesDirectTools({ command: 'x', exposure: 'direct' })).toBe(true)
    expect(exposesDirectTools({ command: 'x', toolExposure: { a: 'direct' } })).toBe(true)
    expect(exposesDirectTools({ command: 'x', exposure: 'deferred' })).toBe(false)
  })
})

describe('names', () => {
  it('namespaces tools as pi does', () => {
    expect(mcpNamespace('augment-knowledge')).toBe('mcp__augment_knowledge')
  })

  it('treats an entry without command, url or type as an override', () => {
    expect(isMcpOverride({ enabled: false })).toBe(true)
    expect(isMcpOverride({ command: 'x' })).toBe(false)
  })
})
