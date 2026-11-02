import { beforeEach, expect, it, vi } from 'vitest'
import { RELEASE_STATUS_KEY } from '@phosphor/pi-extensions/release-status'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { noticeLaneSettled } from './laneNotices'

function release(quiet: boolean, enabled = true) {
  useExtensionUiStore.getState().handleRequest('lane', {
    type: 'extension_ui_request',
    id: 'status',
    method: 'setStatus',
    statusKey: RELEASE_STATUS_KEY,
    statusText: JSON.stringify({ version: 1, available: true, enabled, role: 'active', quiet }),
  })
}

beforeEach(() => {
  useExtensionUiStore.setState({ statuses: {}, toasts: [] })
  useSessionsStore.setState({
    activeSessionId: null,
    live: { lane: { workspacePath: '/repo' } } as unknown as ReturnType<
      typeof useSessionsStore.getState
    >['live'],
  })
})

it("keeps a release lane's routine pass quiet, and announces any other run", () => {
  const notify = vi.spyOn(useExtensionUiStore.getState(), 'notify')
  release(true)
  noticeLaneSettled('lane')
  expect(notify).not.toHaveBeenCalled()
  release(false)
  noticeLaneSettled('lane')
  release(true, false)
  noticeLaneSettled('lane')
  expect(notify).toHaveBeenCalledTimes(2)
})
