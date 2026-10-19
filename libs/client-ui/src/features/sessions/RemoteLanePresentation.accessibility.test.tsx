// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { RemoteLanePresentation } from './RemoteLanePresentation'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

it('keeps exact title navigation names while exposing row state and subtitles as a description', async () => {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    const lane = {
      ...mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!,
      activity: 'stopped' as const,
      branch: 'feature/accessible',
      worktree: true,
      attention: 2,
      read: 1,
    }
    await act(async () =>
      root.render(<RemoteLanePresentation lane={lane} title="Accessible lane" />),
    )
    const row = element.querySelector('button')!
    expect(row.getAttribute('aria-label')).toBe('Accessible lane')
    const id = row.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    const description = document.getElementById(id!)
    expect(description?.textContent).toContain('feature/accessible')
    expect(description?.textContent).toContain('wt')
    expect(description?.textContent).toContain('Unread activity')
  } finally {
    await act(async () => root.unmount())
    element.remove()
  }
})
