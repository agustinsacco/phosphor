// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineSettings } from '@shared/machine-settings'
import { useMachineAgentDraft } from './machineSettingsDrafts'
const data = (revision: string, budget = '200k'): MachineSettings => ({
  section: 'agent',
  revision,
  agent: { contextBudget: budget, autoNameLanes: true, defaultThinkingLevel: 'medium' },
})
let root: Root, container: HTMLDivElement
let api: ReturnType<typeof useMachineAgentDraft>
function Draft({
  host,
  settings,
}: {
  host: string
  settings: Parameters<typeof useMachineAgentDraft>[2]
}) {
  api = useMachineAgentDraft(host, undefined, settings)
  return null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})
it('isolates non-secret drafts by machine and restores them after disconnect/remount', () => {
  const settings = { data: data('r1'), saving: false, change: vi.fn() }
  act(() => root.render(<Draft key="a" host="draft-a" settings={settings} />))
  act(() => api.set('budget', '100k'))
  act(() => root.render(<Draft key="b" host="draft-b" settings={settings} />))
  expect(api.fields.budget).toBe('200k')
  act(() => root.render(<Draft key="a" host="draft-a" settings={settings} />))
  expect(api.fields.budget).toBe('100k')
  expect(api.dirty).toBe(true)
})
it('keeps another form’s unsaved policy while rebasing a confirmed model change', async () => {
  const next = data('r2')
  next.agent!.defaultThinkingLevel = 'high'
  const settings = { data: data('r1'), saving: false, change: vi.fn(async () => next) }
  act(() => root.render(<Draft host="draft-rebase" settings={settings} />))
  act(() => {
    api.set('budget', '100k')
    api.set('thinking', 'high')
  })
  await act(async () => {
    await api.save({ type: 'agent.patch', patch: { defaultThinkingLevel: 'high' } })
    root.render(<Draft host="draft-rebase" settings={{ ...settings, data: next }} />)
  })
  expect(api.fields).toMatchObject({ budget: '100k', thinking: 'high' })
  expect(api.dirty).toBe(true)
  expect(api.stale).toBe(false)
})
it('disables stale drafts rather than silently overwriting an external revision', async () => {
  const settings = { data: data('r1'), saving: false, change: vi.fn() }
  act(() => root.render(<Draft host="draft-stale" settings={settings} />))
  act(() => api.set('budget', '100k'))
  act(() =>
    root.render(<Draft host="draft-stale" settings={{ ...settings, data: data('r2', '400k') }} />),
  )
  expect(api.stale).toBe(true)
  expect(api.fields.budget).toBe('100k')
  await act(async () => {
    await api.save({ type: 'agent.patch', patch: { contextBudget: '100k' } })
  })
  expect(settings.change).not.toHaveBeenCalled()
  act(() => api.discard())
  expect(api.fields.budget).toBe('400k')
  expect(api.dirty).toBe(false)
})
it('normalizes an acknowledged default-budget reset and does not leave a false dirty form', async () => {
  const next = data('r2', '')
  const settings = { data: data('r1'), saving: false, change: vi.fn(async () => next) }
  act(() => root.render(<Draft host="draft-default" settings={settings} />))
  act(() => api.set('budget', ''))
  await act(async () => {
    await api.save({ type: 'agent.patch', patch: { contextBudget: '' } })
    root.render(<Draft host="draft-default" settings={{ ...settings, data: next }} />)
  })
  expect(api.fields.budget).toBe('200k')
  expect(api.dirty).toBe(false)
  expect(api.stale).toBe(false)
})
