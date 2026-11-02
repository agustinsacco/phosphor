// @vitest-environment jsdom
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineSettings, MachineSettingsChange } from '@shared/machine-settings'
import { confirmSettingsNavigation, useMachineAgentDraft } from './machineSettingsDrafts'
import { promptChoice } from '@/stores/prompt'
import { normalizeAgentDirectives } from '@shared/models'
vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn(async () => undefined) }))
const data = (revision: string, budget = '200k'): MachineSettings => ({
  section: 'agent',
  revision,
  agent: { contextBudget: budget, autoNameLanes: true, defaultThinkingLevel: 'medium' },
})
type Change = Extract<MachineSettingsChange, { type: 'agent.patch' }>
/** A Host that checks revisions like the real one, and can hold or refuse a save. */
function fakeHost(initial = data('r1')) {
  const host = {
    current: initial,
    refuse: false,
    held: null as null | Promise<void>,
    patch: vi.fn(async (change: Change, revision: string): Promise<MachineSettings | null> => {
      if (host.held) await host.held
      if (host.refuse || revision !== host.current.revision) return null
      const n = Number(host.current.revision.slice(1)) + 1
      // Directive switches merge into what the Host holds, as on the real Host.
      const { agentDirectives, ...patch } = change.patch
      const agent = { ...host.current.agent!, ...patch }
      if (agentDirectives)
        agent.agentDirectives = normalizeAgentDirectives({
          ...agent.agentDirectives,
          ...agentDirectives,
        })
      host.current = { ...host.current, revision: `r${n}`, agent }
      return host.current
    }),
  }
  return host
}
type Host = ReturnType<typeof fakeHost>
let root: Root, container: HTMLDivElement
let api: ReturnType<typeof useMachineAgentDraft>
let reload: (next: MachineSettings) => void
const announce = vi.fn()
/** The parts of useHostSettings the draft relies on: the latest revision and `saving`. */
function Draft({ id, host }: { id: string; host: Host }) {
  const [settings, setSettings] = useState(host.current)
  const [saving, setSaving] = useState(false)
  reload = setSettings
  async function change(c: MachineSettingsChange) {
    if (saving) return null
    setSaving(true)
    try {
      const next = await host.patch(c as Change, settings.revision)
      if (next) setSettings(next)
      return next
    } finally {
      setSaving(false)
    }
  }
  api = useMachineAgentDraft(id, undefined, { data: settings, saving, change }, announce)
  return null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  announce.mockReset()
  vi.mocked(promptChoice).mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})
it('saves a committed edit on its own and announces it', async () => {
  const host = fakeHost()
  act(() => root.render(<Draft id="auto" host={host} />))
  await act(async () => api.set('thinking', 'high'))
  expect(host.patch).toHaveBeenCalledExactlyOnceWith(
    { type: 'agent.patch', patch: { defaultThinkingLevel: 'high' } },
    'r1',
  )
  expect(announce).toHaveBeenCalledWith({ defaultThinkingLevel: 'high' }, true)
  expect(api.dirty).toBe(false)
  expect(api.fields.thinking).toBe('high')
})
it('queues an edit made while a save is in flight behind the newer revision', async () => {
  const host = fakeHost()
  let release!: () => void
  host.held = new Promise((resolve) => (release = resolve))
  act(() => root.render(<Draft id="queue" host={host} />))
  await act(async () => api.set('thinking', 'high'))
  await act(async () => api.set('budget', '400k'))
  expect(host.patch).toHaveBeenCalledOnce()
  host.held = null
  await act(async () => release())
  expect(host.patch).toHaveBeenLastCalledWith(
    { type: 'agent.patch', patch: { contextBudget: '400k' } },
    'r2',
  )
  expect(host.current.agent).toMatchObject({ defaultThinkingLevel: 'high', contextBudget: '400k' })
  expect(api.dirty).toBe(false)
})
it('keeps a refused change and resends it only when asked', async () => {
  const host = fakeHost()
  host.refuse = true
  act(() => root.render(<Draft id="refused" host={host} />))
  await act(async () => api.set('budget', '100k'))
  expect(announce).toHaveBeenCalledWith({ contextBudget: '100k' }, false)
  expect(api).toMatchObject({ dirty: true, unsaved: true })
  await act(async () => undefined)
  expect(host.patch).toHaveBeenCalledOnce()
  host.refuse = false
  await act(async () => api.retry())
  expect(host.patch).toHaveBeenCalledTimes(2)
  expect(api).toMatchObject({ dirty: false, unsaved: false })
})
it('isolates drafts by machine and holds a restored one for an explicit save', async () => {
  const host = fakeHost()
  host.refuse = true
  act(() => root.render(<Draft key="a" id="draft-a" host={host} />))
  await act(async () => api.set('budget', '100k'))
  host.refuse = false
  act(() => root.render(<Draft key="b" id="draft-b" host={host} />))
  expect(api.fields.budget).toBe('200k')
  await act(async () => root.render(<Draft key="a" id="draft-a" host={host} />))
  expect(api).toMatchObject({ dirty: true, unsaved: true })
  expect(api.fields.budget).toBe('100k')
  expect(host.patch).toHaveBeenCalledOnce()
})
it('disables stale drafts rather than silently overwriting an external revision', async () => {
  const host = fakeHost()
  host.refuse = true
  act(() => root.render(<Draft id="draft-stale" host={host} />))
  await act(async () => api.set('budget', '100k'))
  host.refuse = false
  act(() => reload(data('r9', '400k')))
  expect(api.stale).toBe(true)
  expect(api.unsaved).toBe(false)
  await act(async () => api.retry())
  expect(host.patch).toHaveBeenCalledOnce()
  act(() => api.discard())
  expect(api.fields.budget).toBe('400k')
  expect(api.dirty).toBe(false)
})
it('normalizes an acknowledged default-budget reset and does not leave a false dirty form', async () => {
  const host = fakeHost()
  act(() => root.render(<Draft id="draft-default" host={host} />))
  await act(async () => api.set('budget', ''))
  expect(host.patch).toHaveBeenCalledWith(
    { type: 'agent.patch', patch: { contextBudget: '' } },
    'r1',
  )
  expect(api.fields.budget).toBe('200k')
  expect(api.dirty).toBe(false)
})
it('lets navigation wait for a save in flight instead of refusing or asking', async () => {
  const host = fakeHost()
  let release!: () => void
  host.held = new Promise((resolve) => (release = resolve))
  act(() => root.render(<Draft id="leave" host={host} />))
  await act(async () => api.set('naming', false))
  let allowed: boolean | undefined
  const leaving = confirmSettingsNavigation('leave').then((ok) => (allowed = ok))
  await act(async () => undefined)
  expect(allowed).toBeUndefined()
  await act(async () => release())
  await leaving
  expect(allowed).toBe(true)
  expect(promptChoice).not.toHaveBeenCalled()
})
it('asks before leaving a change the Host refused', async () => {
  const host = fakeHost()
  host.refuse = true
  act(() => root.render(<Draft id="refused-leave" host={host} />))
  await act(async () => api.set('naming', false))
  expect(await confirmSettingsNavigation('refused-leave')).toBe(false)
  expect(promptChoice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Discard unsaved Host settings?' }),
  )
  vi.mocked(promptChoice).mockResolvedValue('discard')
  await act(async () => {
    expect(await confirmSettingsNavigation('refused-leave')).toBe(true)
  })
  expect(api.dirty).toBe(false)
})
it('does not restore a draft whose save landed after the page closed', async () => {
  const host = fakeHost()
  let release!: () => void
  host.held = new Promise((resolve) => (release = resolve))
  act(() => root.render(<Draft key="open" id="closed-mid-save" host={host} />))
  await act(async () => api.set('naming', false))
  act(() => root.render(null))
  host.held = null
  await act(async () => release())
  expect(host.current.agent?.autoNameLanes).toBe(false)
  act(() => root.render(<Draft key="reopened" id="closed-mid-save" host={host} />))
  expect(api).toMatchObject({ dirty: false, stale: false, unsaved: false })
  expect(api.fields.naming).toBe(false)
  expect(announce).not.toHaveBeenCalled()
})
