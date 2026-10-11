import { describe, expect, it } from 'vitest'
import {
  contextFileCommand,
  contextFilesEnvValue,
  normalizeContextFilePrefs,
} from './context-files'

describe('context file prefs', () => {
  it('reads hand-edited JSON as "included" unless it says false', () => {
    expect(normalizeContextFilePrefs(undefined)).toEqual({ claude: true, agents: true })
    expect(normalizeContextFilePrefs({ claude: false, agents: 'no' })).toEqual({
      claude: false,
      agents: true,
    })
  })

  it('speaks the extension’s grammar (pi-ext/context-files.ts)', () => {
    expect(contextFilesEnvValue({ claude: true, agents: true })).toBeUndefined()
    expect(contextFilesEnvValue({ claude: false, agents: false })).toBe('claude=off agents=off')
    expect(contextFileCommand('agents', true)).toBe('/phosphor-context-files agents=on')
  })
})
