import { expect, it } from 'vitest'
import { sessionOwnerOf } from './session-owner'

const session = (sessionId: string, diskPath: string, alive: boolean) => ({
  sessionId,
  diskPath,
  client: { alive },
})

it('names the live pi that owns a transcript', () => {
  expect(sessionOwnerOf([session('s1', '/x/a.jsonl', true)], '/x/a.jsonl')).toBe('s1')
})

it('does not count a pi that exited: a crashed lane is not starting or stopping', () => {
  expect(sessionOwnerOf([session('s1', '/x/a.jsonl', false)], '/x/a.jsonl')).toBeUndefined()
})

it('ignores other transcripts', () => {
  expect(sessionOwnerOf([session('s1', '/x/b.jsonl', true)], '/x/a.jsonl')).toBeUndefined()
})
