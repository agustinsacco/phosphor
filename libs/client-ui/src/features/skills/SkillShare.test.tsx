// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import type { ResolvedSkill } from '@shared/skills'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { SkillMachines, SkillShareActions } from './SkillShare'
import { useSkillPresenceStore } from './skillPresence'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const host = (patch: Partial<HostConnectionView>): HostConnectionView => ({
  connectionToken: 'token',
  state: 'ready',
  capabilities: ['skills.read', 'machine.configure'],
  repositories: [],
  lanes: [],
  ...patch,
})
const skill: ResolvedSkill = {
  name: 'demo',
  description: 'Demo',
  dir: '/agent/skills/demo',
  scope: 'user',
  origin: 'top-level',
  source: 'auto',
  writable: true,
  borrowed: false,
  draft: false,
  files: [{ path: 'SKILL.md', size: 2 }],
  totalSize: 2,
  warnings: [],
}
const bundle = { name: 'demo', files: [{ path: 'SKILL.md', data: btoa('hi') }] }
const container = document.createElement('div')
document.body.append(container)
const root = createRoot(container)
let install: Mock<(...args: unknown[]) => Promise<unknown>>
let invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>

beforeEach(() => {
  useSkillPresenceStore.setState({ byKey: {} })
  useMachinesStore.setState({
    machines: [
      { id: A, label: 'studio' },
      { id: B, label: 'laptop' },
      { id: C, label: 'tower' },
    ] as never,
  })
  useRemoteLanesStore.setState({
    hosts: {
      [A]: host({}),
      [B]: host({ capabilities: ['skills.read'], configurationSupported: true }),
      [C]: host({ state: 'down' }),
    },
  })
  install = vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ status: 'installed', replaced: false })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'hosts:skills')
      return {
        skills: args[0] === A ? [{ ...skill, name: 'demo' }] : [],
        probe: 'rpc',
        userRoot: '',
      }
    if (channel === 'hosts:skillExport') return bundle
    if (channel === 'hosts:skillInstall') return install(...args)
    throw new Error(`unexpected ${channel}`)
  })
  vi.stubGlobal('phosphor', { invoke })
})
afterEach(() => {
  act(() => root.render(null))
  vi.unstubAllGlobals()
})

const text = () => document.body.textContent ?? ''
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find(
    (node) => node.textContent === label || node.getAttribute('aria-label') === label,
  )!
async function render() {
  await act(async () =>
    root.render(
      <>
        <SkillMachines skill={skill} workspacePath="/repo" />
        <SkillShareActions
          skill={skill}
          workspacePath="/repo"
          disabled={false}
          onExport={vi.fn()}
        />
      </>,
    ),
  )
  await act(async () => button('Share').click())
}

it('shows which machines have the name and why others cannot take a copy', async () => {
  await render()
  expect(container.querySelector('[data-testid="skill-machines"]')?.textContent).toBe(
    'Also on studio',
  )
  expect(text()).toContain('Has this skill')
  expect(text()).toContain('Needs configuration access')
  expect(text()).toContain('Not connected')
  expect(button('Copy demo to tower').disabled).toBe(true)
  // A down Host is never listed: only connected ones are asked.
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:skills')).toHaveLength(2)
})

it('asks before replacing, then writes the bundle it already read', async () => {
  install.mockResolvedValueOnce({ status: 'conflict', replaceable: true })
  install.mockResolvedValueOnce({ status: 'installed', replaced: true })
  await render()
  await act(async () => button('Copy demo to studio').click())
  expect(invoke).toHaveBeenCalledWith('hosts:skillExport', {
    machine: 'local',
    name: 'demo',
    dir: '/agent/skills/demo',
  })
  expect(install).toHaveBeenLastCalledWith(A, bundle, false)
  expect(text()).toContain('studio already has a skill named demo')
  await act(async () => button('Replace on studio').click())
  expect(install).toHaveBeenLastCalledWith(A, bundle, true)
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:skillExport')).toHaveLength(1)
  expect(text()).toContain('Replaced on studio')
  expect(text()).toContain('1 file, 2 B')
})

it('blocks a copy that would not replace the other machine’s skill', async () => {
  install.mockResolvedValueOnce({ status: 'conflict', replaceable: false })
  await render()
  await act(async () => button('Copy demo to studio').click())
  expect(text()).toContain('from a package or another folder')
  expect(button('Replace on studio')).toBeUndefined()
  await act(async () => button('Back').click())
  expect(text()).toContain('Copy demo to…')
})

it('reports a failed write, keeps the read step, and retries only when asked', async () => {
  install.mockRejectedValueOnce(new Error('The machine did not confirm the copy.'))
  await render()
  await act(async () => button('Copy demo to studio').click())
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
    'The machine did not confirm the copy.',
  )
  expect(text()).toContain('Read from This Mac')
  expect(install).toHaveBeenCalledTimes(1)
  await act(async () => button('Try again').click())
  expect(install).toHaveBeenCalledTimes(2)
  expect(text()).toContain('Added on studio')
})

it('opens machine settings for a Host that needs configuration access', async () => {
  await render()
  await act(async () => button('Settings').click())
  expect(useMachinesStore.getState().view).toEqual({
    kind: 'machine',
    id: B,
    settings: 'resources',
  })
})
