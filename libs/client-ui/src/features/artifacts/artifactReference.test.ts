import { describe, expect, it } from 'vitest'
import { parseArtifactRef } from '@phosphor/pi-extensions/artifact-store'
import { artifactReference } from './artifactReference'

const SESSION = '0f3c9a2e-1b2c-4d5e-8f90-1234567890ab'

describe('artifactReference', () => {
  it('names the current version without a number', () => {
    expect(artifactReference(SESSION, 'field-guide')).toBe(`artifact://${SESSION}/field-guide`)
  })

  it('pins an older version', () => {
    expect(artifactReference(SESSION, 'field-guide', 2)).toBe(
      `artifact://${SESSION}/field-guide#v2`,
    )
  })

  it('has nothing to copy before pi names the session', () => {
    expect(artifactReference(undefined, 'field-guide')).toBeNull()
  })

  it('writes what artifact_read resolves', () => {
    expect(parseArtifactRef(artifactReference(SESSION, 'field-guide', 4)!)).toEqual({
      session: SESSION,
      slug: 'field-guide',
      version: 4,
    })
  })
})
