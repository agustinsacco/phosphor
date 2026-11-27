import { describe, expect, it } from 'vitest'
import { parseMachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'
import { createTelemetryFeature } from './telemetry'
import type { FeatureContext } from './feature'

const context: FeatureContext = {
  store: { getLane: () => null, listRepositories: () => [] },
  env: {},
  home: process.cwd(),
  log: () => {},
}

describe('the machine.telemetry feature', () => {
  it('is its own feature, on the capability the v1 vocabulary allows', () => {
    const feature = createTelemetryFeature(context)
    // Not a new capability name: see the header. Its own method list is what
    // keeps the read separate from the skills catalogue it rides beside.
    expect(feature.capability).toBe('skills.read')
    expect(feature.methods).toEqual(['machine.telemetry'])
  })

  it('answers with a sample the contract parses', async () => {
    const outcome = await createTelemetryFeature(context).call('machine.telemetry', {})
    expect(outcome.ok).toBe(true)
    expect(parseMachineTelemetry((outcome as { data?: unknown }).data)).not.toBeNull()
  })

  it('refuses another method, and parameters it does not take', async () => {
    const feature = createTelemetryFeature(context)
    expect(await feature.call('machine.claude', {})).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    })
    // A path is never a parameter: the sample is of the Host's own machine and volume.
    expect(await feature.call('machine.telemetry', { home: '/etc' })).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  })
})
