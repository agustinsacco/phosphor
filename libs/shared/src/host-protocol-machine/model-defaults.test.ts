import { describe, expect, it } from 'vitest'
import { machineModelDefaults, parseMachineModelDefaults } from './model-defaults'
import { parseMachineModelList } from '../host-protocol-machine'

const model = { id: 'model', name: 'Model', provider: 'provider', reasoning: false }

describe('machineModelDefaults', () => {
  it('projects only pi’s default model and thinking level from its settings', () => {
    expect(
      machineModelDefaults({
        defaultProvider: 'anthropic',
        defaultModel: 'claude-x',
        defaultThinkingLevel: 'high',
        theme: 'dark',
        compaction: { enabled: true },
        apiKey: 'secret',
      }),
    ).toEqual({ model: { provider: 'anthropic', id: 'claude-x' }, thinkingLevel: 'high' })
  })

  it('needs both ids for a model, and keeps a thinking level set on its own', () => {
    expect(machineModelDefaults({ defaultModel: 'claude-x', defaultThinkingLevel: 'low' })).toEqual(
      { thinkingLevel: 'low' },
    )
    expect(machineModelDefaults({ defaultProvider: 'anthropic' })).toBeUndefined()
    expect(machineModelDefaults({ defaultProvider: 'a', defaultModel: 'b' })).toEqual({
      model: { provider: 'a', id: 'b' },
    })
  })

  it('is undefined when nothing usable is set', () => {
    expect(machineModelDefaults({})).toBeUndefined()
    expect(
      machineModelDefaults({
        defaultProvider: 'p'.repeat(65),
        defaultModel: 'm',
        defaultThinkingLevel: 'extreme',
      }),
    ).toBeUndefined()
    expect(machineModelDefaults({ defaultProvider: 1, defaultModel: ['m'] })).toBeUndefined()
  })
})

describe('parseMachineModelDefaults', () => {
  it('accepts the model, the thinking level, either alone, or neither', () => {
    const full = { model: { provider: 'p', id: 'm' }, thinkingLevel: 'max' }
    expect(parseMachineModelDefaults(full)).toEqual(full)
    expect(parseMachineModelDefaults({ model: { provider: 'p', id: 'm' } })).toEqual({
      model: { provider: 'p', id: 'm' },
    })
    expect(parseMachineModelDefaults({ thinkingLevel: 'off' })).toEqual({ thinkingLevel: 'off' })
    expect(parseMachineModelDefaults({})).toEqual({})
  })

  it('refuses any other key, shape, bound or level', () => {
    for (const value of [
      null,
      [],
      'p/m',
      { model: { provider: 'p', id: 'm' }, theme: 'dark' },
      { model: { provider: 'p', id: 'm', apiKey: 'secret' } },
      { model: { provider: 'p' } },
      { model: 'p/m' },
      { model: { provider: '', id: 'm' } },
      { model: { provider: 'p'.repeat(65), id: 'm' } },
      { model: { provider: 'p', id: 'm'.repeat(201) } },
      { model: { provider: 'p', id: 'm\0' } },
      { thinkingLevel: 'extreme' },
      { thinkingLevel: null },
    ])
      expect(parseMachineModelDefaults(value)).toBeNull()
  })
})

describe('parseMachineModelList', () => {
  it('reads an older Host’s answer without defaults', () => {
    expect(parseMachineModelList({ models: [model], source: 'pi' })).toEqual({ models: [model] })
  })

  it('carries valid defaults and drops malformed ones without losing the catalogue', () => {
    const defaults = { model: { provider: 'provider', id: 'model' }, thinkingLevel: 'low' }
    expect(parseMachineModelList({ models: [model], defaults })).toEqual({
      models: [model],
      defaults,
    })
    for (const bad of [null, 'provider/model', { model: { provider: 'p' } }, { extra: true }])
      expect(parseMachineModelList({ models: [model], defaults: bad })).toEqual({
        models: [model],
      })
  })

  it('refuses an answer whose catalogue is unreadable', () => {
    for (const value of [null, [model], { models: 'x' }, { models: [{}] }, {}])
      expect(parseMachineModelList(value)).toBeNull()
  })
})
