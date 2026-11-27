import { expect, it } from 'vitest'
import { sessionOwnerOf } from './session-owner'

const live = new Set(['s1'])
const stops = new Set(['s3'])
const state = { alive: (id: string) => live.has(id), stopping: (id: string) => stops.has(id) }
const session = (sessionId: string, diskPath: string) => ({ sessionId, diskPath })

it('names the live pi that owns a transcript', () => {
  expect(sessionOwnerOf([session('s1', '/x/a.jsonl')], '/x/a.jsonl', state)).toEqual({
    sessionId: 's1',
    stopping: false,
  })
})

it('does not count a pi that exited: a crashed lane is not starting or stopping', () => {
  expect(sessionOwnerOf([session('s2', '/x/a.jsonl')], '/x/a.jsonl', state)).toBeUndefined()
})

it('ignores other transcripts', () => {
  expect(sessionOwnerOf([session('s1', '/x/b.jsonl')], '/x/a.jsonl', state)).toBeUndefined()
})

it('keeps a stopping pi as the owner until it exits, and says it is stopping', () => {
  expect(sessionOwnerOf([session('s3', '/x/a.jsonl')], '/x/a.jsonl', state)).toEqual({
    sessionId: 's3',
    stopping: true,
  })
})
