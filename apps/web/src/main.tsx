import { createRoot } from 'react-dom/client'
import { createBrowserApi } from './platform'
import '@phosphor/client-ui/styles/index.css'

let dispose = () => {}
async function boot() {
  const bridge = createBrowserApi()
  dispose = () => bridge.dispose()
  window.phosphor = bridge.api
  // The real adapter exists before any shared store or component is evaluated.
  await bridge.start()
  const { CompactApp } = await import('@phosphor/client-ui/compact')
  createRoot(document.getElementById('root')!).render(<CompactApp />)
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // Do not force an update/reload over a draft. Waiting updates activate after
    // the old pages close; APIs and Host data are never cached by the worker.
    void navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' }).catch(() => {})
  }
}
void boot().catch(() => {
  try {
    dispose()
  } catch {
    /* Local cleanup must not hide the recovery action. */
  }
  // Never render raw network/provider errors or token-bearing request details.
  const root = document.getElementById('root')!
  root.replaceChildren()
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = 'Phosphor could not start. Check your connection and try again.'
  const retry = document.createElement('button')
  retry.textContent = 'Try again'
  retry.addEventListener('click', () => location.reload())
  root.append(message, retry)
})
