import { expect, it, vi } from 'vitest'
import { exportLaneHtml, laneSubagentHistory, laneSubagentInspect } from './lane-reads'

const LANE = '00000000-0000-4000-8000-000000000001'
const host = (result: object) => ({
  call: vi.fn(async () => ({ type: 'result', id: 'x', ...result }) as never),
})

it('asks for the export by lane id only and returns the document', async () => {
  const c = host({ ok: true, data: { html: '<html></html>' } })
  await expect(exportLaneHtml(c, LANE)).resolves.toEqual({ html: '<html></html>' })
  expect(c.call).toHaveBeenCalledWith('lane.exportHtml', { laneId: LANE })
})

it.each([
  ['unsupported', 'This Host cannot export lanes yet. Update the Host, then retry.'],
  ['too-large', 'This lane is too large to export from its Host.'],
  ['lane-stopped', 'Resume the lane to export it.'],
  ['forbidden', 'does not include lane control'],
  ['internal', 'the lane query could not complete'],
])('explains a %s export refusal', async (code, message) => {
  const c = host({ ok: false, error: { code, message: 'the lane query could not complete' } })
  await expect(exportLaneHtml(c, LANE)).rejects.toThrow(message)
})

it('refuses a result without a document', async () => {
  for (const data of [null, {}, { html: 1 }])
    await expect(exportLaneHtml(host({ ok: true, data }), LANE)).rejects.toThrow('no export')
})

it('asks for the subagent history by lane id only and returns its records', async () => {
  const entries = [{ id: 'a', parentId: null }]
  const c = host({ ok: true, data: { entries, leafId: 'a' } })
  await expect(laneSubagentHistory(c, LANE)).resolves.toEqual({ entries, leafId: 'a' })
  expect(c.call).toHaveBeenCalledWith('lane.subagentHistory', { laneId: LANE })
})

it.each([
  ['unsupported', 'This Host cannot read subagent history yet. Update the Host, then retry.'],
  ['too-large', "This lane's subagent history is too large to read from its Host."],
  ['lane-stopped', 'Resume the lane to read its subagent history.'],
  ['internal', 'the lane query could not complete'],
])('explains a %s history refusal', async (code, message) => {
  const c = host({ ok: false, error: { code, message: 'the lane query could not complete' } })
  await expect(laneSubagentHistory(c, LANE)).rejects.toThrow(message)
})

it('refuses a result that is not a history', async () => {
  for (const data of [
    null,
    {},
    { entries: [] },
    { entries: {}, leafId: null },
    { entries: [], leafId: 1 },
  ])
    await expect(laneSubagentHistory(host({ ok: true, data }), LANE)).rejects.toThrow(
      'no subagent history',
    )
})

it('asks the Host to inspect one run of the lane, by call', async () => {
  const request = { requestId: 'r', runId: 'run', childId: 'step:0' }
  const c = host({ ok: true, data: null })
  await expect(laneSubagentInspect(request)(c, LANE)).resolves.toBeNull()
  expect(c.call).toHaveBeenCalledWith('lane.subagentInspect', { ...request, laneId: LANE })
})

it('refuses a request it could not send as one command, before the Host', async () => {
  const c = host({ ok: true, data: null })
  for (const request of [null, { requestId: 'r' }, { requestId: 'r', runId: 'a b' }])
    await expect(laneSubagentInspect(request)(c, LANE)).rejects.toThrow('Invalid subagent')
  expect(c.call).not.toHaveBeenCalled()
})

it.each([
  ['unsupported', 'This Host cannot inspect subagents. Update the Host and check pi-subagents'],
  ['lane-stopped', 'Resume the lane to inspect its subagents.'],
  ['internal', 'the lane query could not complete'],
])('explains a %s inspection refusal', async (code, message) => {
  const c = host({ ok: false, error: { code, message: 'the lane query could not complete' } })
  await expect(laneSubagentInspect({ requestId: 'r', runId: 'run' })(c, LANE)).rejects.toThrow(
    message,
  )
})
