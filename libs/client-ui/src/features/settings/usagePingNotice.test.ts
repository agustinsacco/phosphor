// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from './settingsUiStore'
import { noticeUsagePing, USAGE_PING_ROW } from './usagePingNotice'

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const state = (patch: object = {}) => ({
  enabled: true,
  noticeShown: false,
  blocked: null,
  preview: null,
  ...patch,
})

beforeEach(() => {
  invoke.mockReset()
  useExtensionUiStore.setState({ toasts: [] })
  useSettingsUiStore.setState({ open: false, reveal: null })
  // @ts-expect-error partial preload surface
  window.phosphor = { invoke }
})

describe('noticeUsagePing', () => {
  it('tells the user once, then records it so main may start sending', async () => {
    invoke.mockResolvedValueOnce(state())
    await noticeUsagePing()
    expect(invoke.mock.calls).toEqual([
      ['app:usagePing'],
      ['app:setUsagePing', { noticeShown: true }],
    ])
    const [toast] = useExtensionUiStore.getState().toasts
    expect(toast).toMatchObject({ title: 'Anonymous usage ping', kind: 'info' })
    void toast!.onOpen!()
    expect(useSettingsUiStore.getState()).toMatchObject({
      open: true,
      tab: 'advanced',
      reveal: { title: USAGE_PING_ROW },
    })
  })

  it.each([
    ['already shown', state({ noticeShown: true })],
    ['switched off', state({ enabled: false })],
    ['a dev build', state({ blocked: 'dev-build' })],
    ['DO_NOT_TRACK', state({ blocked: 'environment' })],
    ['the browser, which has no answer', undefined],
  ])('says nothing for %s', async (_name, value) => {
    invoke.mockResolvedValueOnce(value)
    await noticeUsagePing()
    expect(useExtensionUiStore.getState().toasts).toEqual([])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('says nothing when main refuses the channel', async () => {
    invoke.mockRejectedValueOnce(new Error('This native service requires Desktop.'))
    await noticeUsagePing()
    expect(useExtensionUiStore.getState().toasts).toEqual([])
  })
})
