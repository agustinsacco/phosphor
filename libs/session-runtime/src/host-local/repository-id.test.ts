import { describe, expect, it } from 'vitest'
import { repositoryIdForPath } from './repository-id'

describe('repositoryIdForPath', () => {
  it('is the first 16 hex digits of the SHA-256 of the path', () => {
    // sha256('/') = 8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1
    expect(repositoryIdForPath('/')).toBe('8a5edab282632443')
    expect(repositoryIdForPath('/a')).toMatch(/^[0-9a-f]{16}$/)
    expect(repositoryIdForPath('/a')).not.toBe(repositoryIdForPath('/a/'))
  })
})
