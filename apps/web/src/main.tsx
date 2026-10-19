import { createRoot } from 'react-dom/client'
import { createBrowserApi } from './platform'
import '@phosphor/client-ui/styles/index.css'

let dispose = () => {}
let showStartup: ((error?: string) => void) | undefined
async function boot(): Promise<void> {
  const bridge = createBrowserApi()
  dispose = () => bridge.dispose()
  window.phosphor = bridge.api
  // The adapter exists before shared UI is evaluated. Apply the stored theme
  // before waiting on the network, then use the same startup view as Desktop.
  const { LoadingScreen, TooltipProvider, applyTheme, resolveTheme } =
    await import('@phosphor/client-ui/bootstrap')
  const prefs = await bridge.api.invoke('app:getPrefs')
  applyTheme(resolveTheme(prefs.theme))
  const root = createRoot(document.getElementById('root')!)
  showStartup = (error) =>
    root.render(
      <TooltipProvider>
        <LoadingScreen
          message="Checking your session…"
          error={error}
          onRetry={() => location.reload()}
        />
      </TooltipProvider>,
    )
  showStartup()
  await bridge.start()
  const { CompactApp } = await import('@phosphor/client-ui/compact')
  root.render(<CompactApp />)
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // Never force a reload over a draft or cache API/Host data.
    void navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' }).catch(() => {})
  }
}
void boot().catch(() => {
  try {
    dispose()
  } catch {
    /* Local cleanup must not hide the recovery action. */
  }
  const message = 'Phosphor could not start. Check your connection and try again.'
  if (showStartup) {
    showStartup(message)
    return
  }
  // The shared chunk itself may be unavailable offline. Keep an asset-free,
  // sanitized retry on the first-paint surface; never show raw provider errors.
  const root = document.getElementById('root')!
  const content = document.createElement('main')
  content.className = 'startup-screen startup-content'
  const status = document.createElement('p')
  status.setAttribute('role', 'alert')
  status.className = 'startup-message'
  status.textContent = message
  const retry = document.createElement('button')
  retry.className = 'startup-action'
  retry.textContent = 'Try again'
  retry.addEventListener('click', () => location.reload())
  content.append(status, retry)
  root.replaceChildren(content)
})
