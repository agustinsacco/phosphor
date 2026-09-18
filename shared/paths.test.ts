import { describe, expect, it } from 'vitest'
import { isWithinFolder, rebaseWithinFolder } from './paths'

describe('isWithinFolder', () => {
  it('accepts the folder itself', () => {
    expect(isWithinFolder('/a/box', '/a/box')).toBe(true)
  })

  it('accepts a descendant at any depth', () => {
    expect(isWithinFolder('/a/box/.phosphor/worktrees/lane', '/a/box')).toBe(true)
  })

  it('refuses a sibling whose name merely starts the same', () => {
    // The whole point of the separator guard: `sandbox-6` and `sandbox-60`
    // are two folders, and renaming one must not claim the other's sessions.
    expect(isWithinFolder('/a/box-2', '/a/box')).toBe(false)
    expect(isWithinFolder('/a/box-2/lane', '/a/box')).toBe(false)
  })

  it('refuses an ancestor', () => {
    expect(isWithinFolder('/a', '/a/box')).toBe(false)
  })

  it('tolerates a trailing separator on the folder', () => {
    expect(isWithinFolder('/a/box/lane', '/a/box/')).toBe(true)
    expect(isWithinFolder('/a/box', '/a/box/')).toBe(true)
  })

  it('accepts Windows separators', () => {
    expect(isWithinFolder('C:\\a\\box\\lane', 'C:\\a\\box')).toBe(true)
    expect(isWithinFolder('C:\\a\\box-2', 'C:\\a\\box')).toBe(false)
  })
})

describe('rebaseWithinFolder', () => {
  it('maps the folder itself to the destination', () => {
    expect(rebaseWithinFolder('/a/box', '/a/box', '/a/crate')).toBe('/a/crate')
  })

  it('carries a descendant across', () => {
    expect(rebaseWithinFolder('/a/box/.pidex/worktrees/lane', '/a/box', '/a/crate')).toBe(
      '/a/crate/.pidex/worktrees/lane',
    )
  })

  it('leaves a path outside the folder alone', () => {
    expect(rebaseWithinFolder('/a/box-2/lane', '/a/box', '/a/crate')).toBe('/a/box-2/lane')
  })

  it('tolerates trailing separators on either side', () => {
    expect(rebaseWithinFolder('/a/box/lane', '/a/box/', '/a/crate/')).toBe('/a/crate/lane')
  })
})
