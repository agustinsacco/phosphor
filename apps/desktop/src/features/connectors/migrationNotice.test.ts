// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { noticeMcpMigration } from './migrationNotice'

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)

beforeEach(() => {
  invoke.mockReset()
  useExtensionUiStore.setState({ toasts: [] })
  // @ts-expect-error partial preload surface
  window.phosphor = { invoke }
})

describe('noticeMcpMigration', () => {
  it('points an adapter install at Connectors, and moves nothing itself', async () => {
    invoke.mockResolvedValue({ legacy: true })
    await noticeMcpMigration()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('mcp:readConfigs', undefined)

    const [toast] = useExtensionUiStore.getState().toasts
    expect(toast).toMatchObject({ kind: 'warning', openLabel: 'Open Connectors' })
    toast!.onOpen!()
    expect(useSettingsUiStore.getState()).toMatchObject({ open: true, tab: 'connectors' })
  })

  it('says nothing once the move is done, or when the config cannot be read', async () => {
    invoke.mockResolvedValueOnce({ legacy: false })
    await noticeMcpMigration()
    invoke.mockRejectedValueOnce(new Error('no main'))
    await noticeMcpMigration()
    expect(useExtensionUiStore.getState().toasts).toEqual([])
  })
})
