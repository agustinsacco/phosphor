import { describe, expect, it } from 'vitest'
import { VOICE_MODELS } from '@shared/voice'
import { VOICE_MANIFEST, modelFiles } from './manifest'

describe('VOICE_MANIFEST', () => {
  it.each(VOICE_MODELS)('$id: the size the settings tab shows is the files', (model) => {
    const files = VOICE_MANIFEST[model.id]
    expect(files.reduce((sum, file) => sum + file.bytes, 0)).toBe(model.downloadBytes)
  })

  it.each(VOICE_MODELS)('$id: every file is pinned', (model) => {
    for (const file of VOICE_MANIFEST[model.id]) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.url).toMatch(/^https:\/\//)
      // A branch name would let the content change under the hash.
      if (file.url.includes('huggingface.co')) expect(file.url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
    }
  })

  it.each(VOICE_MODELS)('$id: has every file the worker loads', (model) => {
    const paths = VOICE_MANIFEST[model.id].map((file) => file.path)
    expect(paths).toEqual(expect.arrayContaining(Object.values(modelFiles(model.id))))
  })
})
