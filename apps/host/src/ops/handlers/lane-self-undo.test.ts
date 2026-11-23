import { expect, it } from 'vitest'
import type { AuditEntry, UndoRecord } from '@phosphor/session-runtime/ops/audit'
import { laneSelfUndoCurrent } from './lane-self-undo'

const ref = 'host:h1/lane:L1'
const entry = (op: string, forward?: Record<string, unknown>, target: string | undefined = ref) =>
  ({
    op,
    target,
    undoRecord: { inverse: { op, args: {} }, ...(forward ? { forward } : {}) },
  }) as AuditEntry & { undoRecord: UndoRecord }

function current(stored: { pinned?: true; marker?: string } | null, title = 'Next') {
  return laneSelfUndoCurrent({
    resolve: (r) =>
      r === ref ? { ref, sessionId: null, title, cwd: '/w', busy: false, controller: null } : null,
    store: { getLane: () => stored as never },
  })
}

it('counts a title, pin or marker the agent set as current only while the lane still has it', async () => {
  const now = current({ pinned: true, marker: '🔥' })
  expect(await now(entry('lane.rename', { name: 'Next' }))).toBe(true)
  expect(await now(entry('lane.rename', { name: 'Old' }))).toBe(false)
  expect(await now(entry('lane.pin', { on: true }))).toBe(true)
  expect(await now(entry('lane.pin', { on: false }))).toBe(false)
  expect(await now(entry('lane.marker', { marker: '🔥' }))).toBe(true)
  expect(await current({})(entry('lane.pin', { on: false }))).toBe(true)
})

it('never counts another op, a missing lane or a change without its args', async () => {
  const now = current({ pinned: true })
  expect(await now(entry('files.rename', { from: 'a', to: 'b' }))).toBe(false)
  expect(await now(entry('lane.pin'))).toBe(false)
  expect(await now(entry('lane.pin', { on: true }, 'host:h1/lane:gone'))).toBe(false)
  expect(await current(null)(entry('lane.pin', { on: true }))).toBe(false)
})
