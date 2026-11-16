// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NavigationProvider, useAwaitableNavigate, useNavigation } from './Navigation'
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

it('awaits Desktop navigation through its stores and routes the browser through its provider', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLayoutStore.setState({ page: null })
  const navigate = vi.fn()
  const opened: Record<string, ReturnType<typeof useAwaitableNavigate>> = {}
  function Probe({ name }: { name: string }) {
    opened[name] = useAwaitableNavigate()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () =>
    root.render(
      <>
        <Probe name="desktop" />
        <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
          <Probe name="browser" />
        </NavigationProvider>
      </>,
    ),
  )
  await opened.desktop!({ to: 'page', page: 'skills' })
  expect(useLayoutStore.getState().page).toBe('skills')
  expect(navigate).not.toHaveBeenCalled()
  await opened.browser!({ to: 'page', page: 'routines' })
  expect(navigate).toHaveBeenCalledWith({ to: 'page', page: 'routines' })
  expect(useLayoutStore.getState().page).toBe('skills')
  await act(async () => root.unmount())
  useLayoutStore.setState({ page: null })
  vi.unstubAllGlobals()
})
