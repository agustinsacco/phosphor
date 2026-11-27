import { describe, expect, it } from 'vitest'
import { parseGrantIssueRequest } from './control-api'
import { parseHostBrainArgs } from './host-brain'
import { parseHostBrainRequest } from './host-brain-request'
import { projectHostBrainResult } from './host-brain-result'
import { parseHostFrame } from './host-protocol'

const generation = '6513c7c5-866b-4df8-b991-69897e1d0234'
const laneId = '859ad058-4ce3-4be5-a1ef-b03d4b0150c6'
const expected = { generation, revision: 12 }

describe('Host Brain wire boundary', () => {
  it('requires a generation for queue and one consistent revision for knowledge edits', () => {
    expect(parseHostBrainRequest({ method: 'brain:queue', args: [laneId], expected })).toEqual({
      method: 'brain:queue',
      args: [laneId],
      expected,
    })
    expect(parseHostBrainRequest({ method: 'brain:queue', args: [laneId] })).toBeNull()
    expect(
      parseHostBrainRequest({ method: 'brain:merge', args: ['Rina', 'Mara', 11], expected }),
    ).toBeNull()
    expect(parseHostBrainRequest({ method: 'brain:reset', args: [] })).toBeNull()
    expect(parseHostBrainRequest({ method: 'brain:reset', args: [], expected })).not.toBeNull()
  })

  it('stops only with the observed turn reference beside the fence', () => {
    expect(parseHostBrainArgs('brain:laneStop', [3, laneId])).toEqual([3, laneId])
    for (const args of [[3], [3, null], [3, '/Harbor/turn'], [3, laneId, 'Rina']])
      expect(parseHostBrainArgs('brain:laneStop', args)).toBeNull()
  })

  it('accepts opaque source lane ids, never paths or claimed actors', () => {
    for (const args of [
      ['/Harbor/Ledger'],
      [{ sessionPath: '/Harbor/Ledger' }],
      [laneId, 'Harbor'],
    ])
      expect(parseHostBrainArgs('brain:queue', args)).toBeNull()
    expect(parseHostBrainRequest({ method: 'brain:status', args: [], actor: 'owner' })).toBeNull()
    expect(parseHostBrainRequest({ method: 'brain:brainAgent', args: [] })).toBeNull()
  })

  it('projects a lane page without credentials, paths or internal controller IDs', () => {
    const raw = {
      next: null,
      fence: 3,
      running: true,
      turn: laneId,
      messaging: false,
      controller: { clientId: laneId, self: true, label: 'Harbor' },
      entries: [
        { id: 'entry-1', role: 'assistant', text: 'Northwind', sessionPath: '/Kestrel/Ledger' },
      ],
      dialogs: [
        {
          type: 'extension_ui_request',
          id: 'question-1',
          method: 'confirm',
          title: 'Kestrel',
          message: 'Ledger',
          token: 'Harbor',
        },
      ],
    }
    expect(projectHostBrainResult('brain:laneShow', raw)?.value).toEqual({
      next: null,
      fence: 3,
      running: true,
      turn: laneId,
      messaging: false,
      controller: { self: true, label: 'Harbor' },
      entries: [{ id: 'entry-1', role: 'assistant', text: 'Northwind' }],
      dialogs: [
        {
          type: 'extension_ui_request',
          id: 'question-1',
          method: 'confirm',
          title: 'Kestrel',
          message: 'Ledger',
        },
      ],
    })
  })

  it('requires explicit, bounded rights on issue and accepts a missing renewal claim only as absent', () => {
    const ids = { hostId: generation, clientId: laneId }
    expect(parseGrantIssueRequest({ ...ids, brainAccess: ['read'] })).toEqual({
      ok: true,
      value: { ...ids, brainAccess: ['read'] },
    })
    expect(parseGrantIssueRequest({ ...ids, brainAccess: 'read' })).toEqual({
      ok: false,
      reason: 'brain-access',
    })
    const renew = { type: 'auth-renewed', grantExpiresAt: '2026-11-25T00:00:00.000Z' }
    expect(parseHostFrame(JSON.stringify(renew))).toEqual({ ok: true, value: renew })
    expect(
      parseHostFrame(JSON.stringify({ ...renew, brainAccess: ['control', 'control'] })).ok,
    ).toBe(false)
    expect(parseHostFrame(JSON.stringify({ ...renew, brainAccess: [] }))).toEqual({
      ok: true,
      value: { ...renew, brainAccess: [] },
    })
  })
})

it('separates Host lane filters from internal pi provenance', () => {
  expect(
    parseHostBrainArgs('brain:entityMemories', ['Rina', { sessionId: laneId }, null]),
  ).toBeNull()
  expect(parseHostBrainArgs('brain:entityMemories', ['Rina', { laneId }, null])).toEqual([
    'Rina',
    { laneId },
    null,
  ])
})
