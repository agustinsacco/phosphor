import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/monaco', () => ({}))
import { useFilesStore } from '@/stores/files'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { topLevelPaths, transferFiles } from './fileTransfers'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('prunes duplicate and nested selections without confusing sibling prefixes', () => {
  expect(topLevelPaths(['/a', '/a/b', '/a', '/ab'])).toEqual(['/a', '/ab'])
  expect(topLevelPaths(['C:\\a', 'C:\\a\\b'])).toEqual(['C:\\a'])
})
it('reconciles successful moves and leaves only failures on the cut clipboard', async () => {
  const refresh = vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  const reconcile = vi.spyOn(useFilesStore.getState(), 'reconcilePath').mockImplementation(() => {})
  const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast').mockImplementation(() => 0)
  const paths = ['/repo/a', '/repo/b']
  const invoke = vi.fn(async (channel, ...args) => {
    if (channel === 'fs:transfer') {
      if (args[1] === paths[1]) throw new Error('Already exists')
      return '/repo/moved-a'
    }
    if (channel === 'clipboard:readFiles') return { paths, cut: true }
  })
  vi.stubGlobal('window', { phosphor: { invoke } })
  await transferFiles('/repo', paths, '/repo', true)
  expect(reconcile).toHaveBeenCalledExactlyOnceWith('/repo', '/repo/a', '/repo/moved-a')
  expect(invoke).toHaveBeenCalledWith('clipboard:writeFiles', ['/repo/b'], true)
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('1 completed; 1 failed'), 'error')
  expect(refresh).toHaveBeenCalledWith('/repo', '/repo')
})
it('keeps a target folder the user opened while the transfer ran open', async () => {
  useFilesStore.setState({ expanded: {} })
  vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  vi.spyOn(useExtensionUiStore.getState(), 'pushToast').mockImplementation(() => 0)
  const toggle = vi.spyOn(useFilesStore.getState(), 'toggleDir')
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'fs:transfer') {
      useFilesStore.setState({ expanded: { '/repo/dir': true } })
      return '/repo/dir/a'
    }
    if (channel === 'clipboard:readFiles') return { paths: [], cut: false }
  })
  vi.stubGlobal('window', { phosphor: { invoke } })
  await transferFiles('/repo', ['/repo/a'], '/repo/dir', false)
  expect(toggle).not.toHaveBeenCalled()
  expect(useFilesStore.getState().expanded['/repo/dir']).toBe(true)
})
