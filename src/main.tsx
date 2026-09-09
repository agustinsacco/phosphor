import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { LoadingScreen } from './app/LoadingScreen'
import { useSettingsStore } from './stores/settings'
import { hostPlatform } from './lib/shortcuts'
import { loadBundledFonts } from './lib/fonts'
import './styles/index.css'

async function bootstrap(): Promise<void> {
  // Plain-browser dev (vite server without Electron): install the mock API.
  if (import.meta.env.DEV && typeof window.phosphor === 'undefined') {
    const { installMockPhosphor } = await import('./dev/mockPhosphor')
    installMockPhosphor()
    document.documentElement.classList.add('dark')
    // Debug access to stores from the browser console.
    void import('./stores/chat').then((m) => {
      ;(window as unknown as Record<string, unknown>).__chatStore = m.useChatStore
    })
    void import('./stores/sessions').then((m) => {
      ;(window as unknown as Record<string, unknown>).__sessionsStore = m.useSessionsStore
    })
    void import('./stores/extensionUi').then((m) => {
      ;(window as unknown as Record<string, unknown>).__extUiStore = m.useExtensionUiStore
    })
  }

  // Platform class on <html>, set before the first paint so the CSS that
  // reserves space for window controls (.titlebar-inset-start) never flashes
  // the wrong layout. Read after the mock install above, or browser-only dev
  // has no bridge to ask.
  document.documentElement.classList.add(`platform-${hostPlatform()}`)

  const root = ReactDOM.createRoot(document.getElementById('root')!)
  root.render(<LoadingScreen />)
  try {
    // Show the startup surface while fonts settle, but keep metric-sensitive
    // editors/terminals unmounted until then. Appearance loads in parallel.
    await Promise.all([loadBundledFonts(), useSettingsStore.getState().hydrate()])
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
  } catch {
    root.render(
      <LoadingScreen
        error="Couldn’t load your preferences."
        onRetry={() => window.location.reload()}
      />,
    )
  }
}

void bootstrap()
