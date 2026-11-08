import { expect, it } from 'vitest'
import { cloneFold, emptyFold, foldLine, metaFromFold } from './session-fold'
import { BRAIN_OWNER_CUSTOM_TYPE } from './brain-session-owner'

it('projects a persisted processor owner without putting it in transcript messages', () => {
  const state = emptyFold()
  foldLine(
    state,
    JSON.stringify({ type: 'session', id: 'session', cwd: '/isolated', timestamp: 'created' }),
  )
  foldLine(
    state,
    JSON.stringify({
      type: 'custom',
      customType: BRAIN_OWNER_CUSTOM_TYPE,
      data: { kind: 'brain', jobId: 'job' },
    }),
  )
  const meta = metaFromFold(cloneFold(state), '/owned/session.jsonl', 42)
  expect(meta?.brainOwner).toEqual({ kind: 'brain', jobId: 'job' })
  expect(meta?.userMessages).toBe(0)
  expect(meta?.assistantMessages).toBe(0)
  expect(meta?.firstUserText).toBeUndefined()
  expect(meta?.entryCount).toBe(1)
})

it('does not give ordinary or malformed custom entries processor ownership or erase existing ownership', () => {
  const state = emptyFold()
  foldLine(state, JSON.stringify({ type: 'session', id: 'ordinary' }))
  for (const entry of [
    {
      type: 'message',
      customType: BRAIN_OWNER_CUSTOM_TYPE,
      message: { role: 'user', content: 'hi' },
    },
    { type: 'custom', customType: 'other', data: { kind: 'brain', jobId: 'job' } },
    {
      type: 'custom',
      customType: BRAIN_OWNER_CUSTOM_TYPE,
      data: { kind: 'routine', jobId: 'job' },
    },
    { type: 'custom', customType: BRAIN_OWNER_CUSTOM_TYPE, data: { kind: 'brain', jobId: '' } },
  ])
    foldLine(state, JSON.stringify(entry))
  expect(metaFromFold(state, '/ordinary', 0)).not.toHaveProperty('brainOwner')
  foldLine(
    state,
    JSON.stringify({
      type: 'custom',
      customType: BRAIN_OWNER_CUSTOM_TYPE,
      data: { kind: 'brain', jobId: 'job' },
    }),
  )
  foldLine(
    state,
    JSON.stringify({ type: 'custom', customType: BRAIN_OWNER_CUSTOM_TYPE, data: null }),
  )
  expect(metaFromFold(state, '/ordinary', 0)?.brainOwner).toEqual({ kind: 'brain', jobId: 'job' })
})
