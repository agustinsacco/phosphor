import { beforeEach, expect, it, vi } from 'vitest'
import { useSkillsStore } from './skills'
import { useRemoteLanesStore } from './remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

const invoke = vi.fn()
const workspace = `host:${MOCK_HOST_ID}/repository`
beforeEach(() => {
  vi.stubGlobal('window', { phosphor: { invoke } })
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]
  if (host) host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts })
  useSkillsStore.setState({ byWorkspace: {}, loading: {}, error: {} })
  invoke.mockReset().mockResolvedValue({ skills: [], probe: 'rpc', userRoot: workspace })
})
it('keeps local skills unchanged and gates remote lane reads', async () => {
  await useSkillsStore.getState().refresh('/repo')
  expect(invoke).toHaveBeenCalledWith('skills:list', '/repo')
  invoke.mockClear()
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  await useSkillsStore.getState().refresh(workspace)
  expect(invoke).not.toHaveBeenCalled()
})
it('ignores stale lane skills after reconnect instead of replacing the inventory', async () => {
  invoke.mockImplementation(async () => {
    useRemoteLanesStore.setState((s) => ({
      hosts: { ...s.hosts, [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, state: 'reconnecting' } },
    }))
    useRemoteLanesStore.setState((s) => ({
      hosts: { ...s.hosts, [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, state: 'ready' } },
    }))
    return { skills: [], probe: 'rpc', userRoot: workspace }
  })
  await useSkillsStore.getState().refresh(workspace)
  expect(useSkillsStore.getState().byWorkspace[workspace]).toBeUndefined()
})

it('accepts delayed lane skills across unchanged periodic snapshots', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = useSkillsStore.getState().refresh(workspace)
  for (let tick = 0; tick < 3; tick++)
    useRemoteLanesStore.setState({ hosts: structuredClone(useRemoteLanesStore.getState().hosts) })
  finish({ skills: [], probe: 'rpc', userRoot: workspace })
  await pending
  expect(useSkillsStore.getState().byWorkspace[workspace]).toBeDefined()
})

it('does not let a delayed local inventory clear a newly selected remote skill', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  useSkillsStore.getState().select('/repo/old-skill')
  const pending = useSkillsStore.getState().refresh('/repo')
  const remoteSkill = `${workspace}/skill:new`
  useSkillsStore.getState().select(null)
  useSkillsStore.getState().select(remoteSkill)
  finish({ skills: [], probe: 'rpc', userRoot: '/repo' })
  await pending
  expect(useSkillsStore.getState().selectedDir).toBe(remoteSkill)
  expect(useSkillsStore.getState().byWorkspace['/repo']).toBeDefined()
})

it('does not let a delayed local inventory clear a newer local selection', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  useSkillsStore.getState().select('/repo/old-skill')
  const pending = useSkillsStore.getState().refresh('/repo')
  useSkillsStore.getState().select('/repo/new-skill')
  finish({ skills: [], probe: 'rpc', userRoot: '/repo' })
  await pending
  expect(useSkillsStore.getState().selectedDir).toBe('/repo/new-skill')
})

it('still clears a removed local skill when selection has not changed', async () => {
  useSkillsStore.getState().select('/repo/old-skill')
  await useSkillsStore.getState().refresh('/repo')
  expect(useSkillsStore.getState().selectedDir).toBeNull()
})

it('does not clear an existing remote selection during a local background refresh', async () => {
  const remoteSkill = `${workspace}/skill:new`
  useSkillsStore.getState().select(remoteSkill)
  await useSkillsStore.getState().refresh('/repo')
  expect(useSkillsStore.getState().selectedDir).toBe(remoteSkill)
})
