import { describe, it, expect } from 'vitest'
import { committedRename } from './inlineRename'

describe('committedRename', () => {
  it('returns the trimmed draft when it differs', () => {
    expect(committedRename('  Payments audit  ', 'Untitled session')).toBe('Payments audit')
  })

  it('is a no-op for an empty or whitespace-only draft', () => {
    expect(committedRename('', 'Untitled session')).toBeUndefined()
    expect(committedRename('   ', 'Untitled session')).toBeUndefined()
  })

  it('is a no-op when the name did not change', () => {
    // Blur fires when the user clicks away without editing, so "same name"
    // must not spend an RPC or bump the session file's mtime.
    expect(committedRename('Untitled session', 'Untitled session')).toBeUndefined()
    expect(committedRename(' Untitled session ', 'Untitled session')).toBeUndefined()
  })
})
