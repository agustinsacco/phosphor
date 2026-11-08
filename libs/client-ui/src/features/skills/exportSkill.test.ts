import { beforeEach, expect, it, vi } from 'vitest'
import { exportSkill } from './exportSkill'

const invoke = vi.fn()
const skill = { name: 'demo', dir: '/agent/skills/demo' }
const bundle = { name: 'demo', files: [{ path: 'SKILL.md', data: btoa('skill') }] }
beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke } })
})

it('This Mac zips its own folder, with no share limits', async () => {
  invoke.mockResolvedValue({ savedTo: '/out/demo.zip' })
  expect(await exportSkill(skill, 'local')).toEqual({ savedTo: '/out/demo.zip' })
  expect(invoke.mock.calls).toEqual([['skills:export', '/agent/skills/demo']])
})

it("a Host's skill is read as its share bundle, then saved on this device", async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'hosts:skillExport' ? bundle : { savedTo: '/out/demo.zip' },
  )
  expect(await exportSkill(skill, 'host-1')).toEqual({ savedTo: '/out/demo.zip' })
  expect(invoke.mock.calls).toEqual([
    ['hosts:skillExport', { machine: 'host-1', name: 'demo' }],
    ['skills:saveBundle', bundle],
  ])
})
