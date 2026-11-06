import { describe, expect, it } from 'vitest'
import { extractVersion } from './versions'

describe('version extraction', () => {
  it('reads a bare version line', () => {
    expect(extractVersion('0.78.0\n')).toBe('0.78.0')
  })

  it('finds the version among surrounding noise', () => {
    // Version managers and pi itself can emit warnings first.
    expect(extractVersion('Warning: settings.json parse error\n0.78.0\n')).toBe('0.78.0')
    expect(extractVersion('pi version 0.83.1')).toBe('0.83.1')
  })

  it('supports prerelease suffixes', () => {
    expect(extractVersion('0.84.0-beta.2')).toBe('0.84.0-beta.2')
  })

  it('returns null when there is no version at all', () => {
    // The regression: `env: node: No such file or directory` on stderr with
    // empty stdout must not be mistaken for a version string.
    expect(extractVersion('')).toBeNull()
    expect(extractVersion('env: node: No such file or directory')).toBeNull()
  })
})
