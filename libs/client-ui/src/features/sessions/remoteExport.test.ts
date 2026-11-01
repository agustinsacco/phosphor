// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { exportRemoteLaneHtml } from './sessionActions'

const invoke = vi.fn()
beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', Object.assign(window, { phosphor: { invoke } }))
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('lane')
})
afterEach(() => vi.restoreAllMocks())

const answer = (replies: Record<string, unknown>) =>
  invoke.mockImplementation(async (channel: string) => {
    const reply = replies[channel]
    if (reply instanceof Error) throw reply
    return reply
  })

it('Desktop: asks where first, writes the Host export there and reveals it', async () => {
  answer({ 'app:saveDialog': '/out/a.html', 'hosts:exportLaneHtml': { html: '<h1>x</h1>' } })
  await exportRemoteLaneHtml('lane', 'My/lane', true)
  expect(invoke.mock.calls).toEqual([
    [
      'app:saveDialog',
      expect.objectContaining({ defaultPath: 'My-lane.html', title: 'Export session as HTML' }),
    ],
    ['hosts:exportLaneHtml', 'lane'],
    ['fs:writeFile', '/out/a.html', '<h1>x</h1>'],
    ['app:revealPath', '/out/a.html'],
  ])
})

it('Desktop: a cancelled dialog never asks the Host', async () => {
  answer({ 'app:saveDialog': null })
  await exportRemoteLaneHtml('lane', 'lane', true)
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['app:saveDialog'])
})

it('a browser downloads the Host export, with no native channel', async () => {
  answer({ 'hosts:exportLaneHtml': { html: '<h1>x</h1>' } })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  await exportRemoteLaneHtml('lane', 'lane', false)
  expect(invoke.mock.calls).toEqual([['hosts:exportLaneHtml', 'lane']])
  expect(click).toHaveBeenCalledOnce()
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('lane.html')
  // Never text/html: a browser that ignores `download` must not render it in the app's origin.
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob
  expect(blob.type).toBe('application/octet-stream')
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
})

it('names an unnamed lane "session", never a hidden ".html"', async () => {
  answer({ 'app:saveDialog': null })
  await exportRemoteLaneHtml('lane', ' ', true)
  expect(invoke).toHaveBeenCalledWith(
    'app:saveDialog',
    expect.objectContaining({ defaultPath: 'session.html' }),
  )
})

it("shows the Host's refusal on the lane's chat", async () => {
  answer({ 'hosts:exportLaneHtml': new Error('Resume the lane to export it.') })
  await exportRemoteLaneHtml('lane', 'lane', false)
  expect(useChatStore.getState().sessions.lane?.error).toBe(
    'Export failed: Resume the lane to export it.',
  )
})
