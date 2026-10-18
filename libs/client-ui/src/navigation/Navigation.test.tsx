// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useNavigation } from './Navigation'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'

it('projects existing Desktop stores without introducing native URLs or new persistence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn()
  vi.stubGlobal('phosphor', { invoke })
  useSessionsStore.setState({ activeSessionId: null })
  useLayoutStore.setState({ page: null })
  const originalUrl = window.location.href
  function Desktop() {
    const { location } = useNavigation()
    return <p>{location.to === 'page' ? location.page : location.to}</p>
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Desktop />))
  expect(container.textContent).toBe('lanes')
  await act(async () => useLayoutStore.getState().setPage('skills'))
  expect(container.textContent).toBe('skills')
  expect(window.location.href).toBe(originalUrl)
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => root.unmount())
  useLayoutStore.setState({ page: null })
  vi.unstubAllGlobals()
})
