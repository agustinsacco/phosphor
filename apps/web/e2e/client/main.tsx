import { createRoot } from 'react-dom/client'
import { createBrowserApi } from '../../src/platform'
import { openHostSocket } from '@phosphor/host-client/socket'
import '@phosphor/client-ui/styles/index.css'

// Test-only entry, never included in the production build. Only transport is mapped:
// real grants, browser crypto, proof checking, projections and UI remain unchanged.
const bridge = createBrowserApi({
  socket: (url) => {
    const target = new URL(url)
    if (target.origin !== 'wss://fixture.ts.net' || target.pathname !== '/v1/stream')
      return Promise.reject(new Error('Unexpected fixture endpoint'))
    return openHostSocket(`ws://${location.host}/fixture-host`)
  },
})
window.phosphor = bridge.api
await bridge.start()
const root = createRoot(document.getElementById('root')!)
if (location.pathname === '/sandbox') {
  const { SandboxedHtml } = await import('@/components/SandboxedHtml')
  const { PlatformProvider, COMPACT_PLATFORM } = await import('@/platform/Platform')
  const { hostileHtml } = await import('../hostile-html')
  root.render(
    <PlatformProvider value={COMPACT_PLATFORM}>
      <SandboxedHtml html={hostileHtml} title="Hostile synthetic preview" />
    </PlatformProvider>,
  )
} else {
  const { CompactApp } = await import('@phosphor/client-ui/compact')
  root.render(<CompactApp />)
  await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' })
}
window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
