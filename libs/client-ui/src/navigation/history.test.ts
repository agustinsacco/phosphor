// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createHistoryNavigation } from './history'

afterEach(() => window.history.replaceState(null, '', '/'))
it('writes real URLs without state payloads and follows popstate', () => {
  const navigation = createHistoryNavigation(window)
  const listener = vi.fn()
  const off = navigation.subscribe(listener)
  navigation.navigate({ to: 'lane', lane: { hostId: 'host', laneId: 'lane' }, pane: 'files' })
  expect(window.location.pathname).toBe('/lanes/host/lane/files')
  expect(window.history.state).toBeNull()
  window.history.replaceState(null, '', '/pages/machines')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(navigation.getSnapshot()).toEqual({ to: 'page', page: 'machines' })
  expect(listener).toHaveBeenCalledTimes(2)
  off()
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(listener).toHaveBeenCalledTimes(2)
  navigation.dispose()
})
it('can subscribe again after strict-mode cleanup without losing back navigation', () => {
  const navigation = createHistoryNavigation(window)
  navigation.subscribe(() => {})()
  const off = navigation.subscribe(() => {})
  window.history.replaceState(null, '', '/pages/machines')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(navigation.getSnapshot()).toEqual({ to: 'page', page: 'machines' })
  off()
})
