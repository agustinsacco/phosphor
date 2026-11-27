import { expect, it } from 'vitest'
import { sessionOwnerOf } from './session-owner'

const live = new Set(['s1'])
const alive = (sessionId: string) => live.has(sessionId)
const session = (sessionId: string, diskPath: string) => ({ sessionId, diskPath })

it('names the live pi that owns a transcript', () => {
  expect(sessionOwnerOf([session('s1', '/x/a.jsonl')], '/x/a.jsonl', alive)).toBe('s1')
})

it('does not count a pi that exited: a crashed lane is not starting or stopping', () => {
  expect(sessionOwnerOf([session('s2', '/x/a.jsonl')], '/x/a.jsonl', alive)).toBeUndefined()
})

it('ignores other transcripts', () => {
  expect(sessionOwnerOf([session('s1', '/x/b.jsonl')], '/x/a.jsonl', alive)).toBeUndefined()
})

it('keeps a stopping pi as the owner until it exits', () => {
  const stopping = (sessionId: string) => sessionId === 's2'
  expect(
    sessionOwnerOf([session('s2', '/x/a.jsonl')], '/x/a.jsonl', (id) => alive(id) || stopping(id)),
  ).toBe('s2')
})
