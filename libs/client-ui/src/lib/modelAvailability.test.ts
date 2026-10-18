import { describe, expect, it } from 'vitest'
import { availabilityKey, baseModelId, isProfileId, unavailableModels } from './modelAvailability'

const bedrock = (id: string) => ({ id, provider: 'amazon-bedrock' })

describe('baseModelId / isProfileId', () => {
  it('strips region and routing prefixes', () => {
    expect(baseModelId('global.anthropic.claude-fable-5')).toBe('anthropic.claude-fable-5')
    expect(baseModelId('us.anthropic.claude-opus-5')).toBe('anthropic.claude-opus-5')
    expect(baseModelId('eu.anthropic.claude-sonnet-5')).toBe('anthropic.claude-sonnet-5')
    expect(baseModelId('jp.anthropic.claude-opus-5')).toBe('anthropic.claude-opus-5')
  })

  it('leaves bare ids alone', () => {
    expect(baseModelId('anthropic.claude-fable-5')).toBe('anthropic.claude-fable-5')
    expect(baseModelId('amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0')
  })

  it('does not treat a long first segment as a region prefix', () => {
    // `anthropic.` must never read as a region prefix, or every model id would
    // collapse to its suffix.
    expect(isProfileId('anthropic.claude-fable-5')).toBe(false)
    expect(isProfileId('amazon.nova-lite-v1:0')).toBe(false)
    expect(isProfileId('us.anthropic.claude-fable-5')).toBe(true)
    expect(isProfileId('global.anthropic.claude-fable-5')).toBe(true)
  })
})

describe('unavailableModels', () => {
  it('flags a bare id when region-prefixed profiles exist for it', () => {
    const models = [
      bedrock('anthropic.claude-fable-5'),
      bedrock('us.anthropic.claude-fable-5'),
      bedrock('eu.anthropic.claude-fable-5'),
      bedrock('global.anthropic.claude-fable-5'),
    ]
    const flagged = unavailableModels(models)
    const entry = flagged.get('amazon-bedrock/anthropic.claude-fable-5')
    expect(entry?.reason).toBe('requires-inference-profile')
    expect(entry?.alternatives).toEqual([
      'eu.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5',
      'us.anthropic.claude-fable-5',
    ])
  })

  it('never flags the profile ids themselves', () => {
    const models = [bedrock('anthropic.claude-fable-5'), bedrock('global.anthropic.claude-fable-5')]
    const flagged = unavailableModels(models)
    expect(flagged.has('amazon-bedrock/global.anthropic.claude-fable-5')).toBe(false)
    expect(flagged.size).toBe(1)
  })

  it('leaves bare ids with no profile siblings alone', () => {
    // Nova and Claude 3.x are genuinely invocable on-demand.
    const models = [
      bedrock('amazon.nova-pro-v1:0'),
      bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
    ]
    expect(unavailableModels(models).size).toBe(0)
  })

  it('ignores non-Bedrock providers entirely', () => {
    const models = [
      { id: 'gpt-5', provider: 'openai' },
      { id: 'us.gpt-5', provider: 'openai' },
      { id: 'Qwen 3.5 122b', provider: 'local-stark' },
    ]
    expect(unavailableModels(models).size).toBe(0)
  })

  it('does not cross-contaminate distinct model families', () => {
    const models = [
      bedrock('anthropic.claude-fable-5'),
      bedrock('global.anthropic.claude-fable-5'),
      bedrock('anthropic.claude-sonnet-5'),
    ]
    const flagged = unavailableModels(models)
    // sonnet-5 has no profile sibling here, so it must stay unflagged.
    expect(flagged.has('amazon-bedrock/anthropic.claude-sonnet-5')).toBe(false)
    expect(flagged.has('amazon-bedrock/anthropic.claude-fable-5')).toBe(true)
  })

  it('handles an empty catalogue', () => {
    expect(unavailableModels([]).size).toBe(0)
  })
})

describe('availabilityKey', () => {
  it('matches the map keys unavailableModels produces', () => {
    const model = bedrock('anthropic.claude-fable-5')
    const flagged = unavailableModels([model, bedrock('us.anthropic.claude-fable-5')])
    expect(flagged.has(availabilityKey(model))).toBe(true)
  })
})
