import { expect, it, vi } from 'vitest'
import { exportLaneHtml } from './lane-export'

const LANE = '00000000-0000-4000-8000-000000000001'
const host = (result: object) => ({
  call: vi.fn(async () => ({ type: 'result', id: 'x', ...result }) as never),
})

it('asks for the lane by id only and returns the document', async () => {
  const c = host({ ok: true, data: { html: '<html></html>' } })
  await expect(exportLaneHtml(c, LANE)).resolves.toEqual({ html: '<html></html>' })
  expect(c.call).toHaveBeenCalledWith('lane.exportHtml', { laneId: LANE })
})

it.each([
  ['unsupported', 'This Host cannot export lanes yet. Update the Host, then retry.'],
  ['too-large', 'This lane is too large to export from its Host.'],
  ['lane-stopped', 'Resume the lane to export it.'],
  ['internal', 'the lane query could not complete'],
])('explains a %s refusal', async (code, message) => {
  const c = host({ ok: false, error: { code, message: 'the lane query could not complete' } })
  await expect(exportLaneHtml(c, LANE)).rejects.toThrow(message)
})

it('refuses a result without a document', async () => {
  for (const data of [null, {}, { html: 1 }])
    await expect(exportLaneHtml(host({ ok: true, data }), LANE)).rejects.toThrow('no export')
})
