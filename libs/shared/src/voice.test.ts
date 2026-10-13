import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_PREFS, VOICE_MODELS, normalizeVoicePrefs } from './voice'

describe('normalizeVoicePrefs', () => {
  it('reads missing or malformed prefs as the default', () => {
    expect(normalizeVoicePrefs(undefined)).toEqual(DEFAULT_VOICE_PREFS)
    expect(normalizeVoicePrefs({ enabled: 'yes', model: 'whisper' })).toEqual(DEFAULT_VOICE_PREFS)
  })

  it('keeps a valid choice', () => {
    expect(normalizeVoicePrefs({ enabled: true, model: 'moonshine-base-en' })).toEqual({
      enabled: true,
      model: 'moonshine-base-en',
    })
  })

  it('defaults to the first, smallest model', () => {
    expect(VOICE_MODELS[0]!.id).toBe(DEFAULT_VOICE_PREFS.model)
  })
})
