import { describe, it, expect } from 'vitest'
import {
  ALL_THINKING_LEVELS,
  supportedThinkingLevels,
  clampThinkingLevel,
  hasThinkingChoice,
  type ThinkingCapableModel,
} from './thinking.js'

describe('ALL_THINKING_LEVELS', () => {
  it('includes max, which Phosphor omitted', () => {
    expect(ALL_THINKING_LEVELS).toContain('max')
  })
  it("matches pi's own order", () => {
    // From dist/node_modules/@earendil-works/pi-ai/dist/models.js
    expect(ALL_THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('supportedThinkingLevels', () => {
  it('returns only off for non-reasoning', () => {
    expect(supportedThinkingLevels({ reasoning: false })).toEqual(['off'])
  })
  it('returns standard five levels for no map', () => {
    expect(supportedThinkingLevels({ reasoning: true })).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ])
  })
  it('filters out null-marked levels (Kimi K2.5, minimal:null)', () => {
    expect(
      supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null } }),
    ).toEqual(['off', 'low', 'medium', 'high'])
  })
  it('requires xhigh and max to be explicitly defined', () => {
    // Absent key = unsupported for xhigh/max (pi rule)
    expect(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: {} })).not.toContain(
      'xhigh',
    )
    expect(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: {} })).not.toContain('max')
    expect(
      supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'boost' } }),
    ).toContain('xhigh')
  })
  it('mirrors Kimi K2.5 exactly', () => {
    // From amazon-bedrock.json: thinkingLevelMap: null
    expect(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: null })).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ])
  })
})

describe('clampThinkingLevel', () => {
  it('returns requested level if supported', () => {
    expect(clampThinkingLevel({ reasoning: true }, 'low')).toBe('low')
  })
  it('clamps up when requested unsupported, then down', () => {
    // Model without map cannot support xhigh
    const m: ThinkingCapableModel = { reasoning: true }
    expect(clampThinkingLevel(m, 'xhigh')).toBe('high')
    expect(clampThinkingLevel(m, 'max')).toBe('high')
  })
  it('clamps down when reasoning is off and user asks for thinking', () => {
    expect(clampThinkingLevel({ reasoning: false }, 'high')).toBe('off')
  })
})

describe('hasThinkingChoice', () => {
  it('false for single-level model', () => {
    expect(hasThinkingChoice({ reasoning: false })).toBe(false)
  })
  it('true for standard reasoning model', () => {
    expect(hasThinkingChoice({ reasoning: true })).toBe(true)
  })
})
