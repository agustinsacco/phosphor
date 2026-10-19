import { useEffect, useState } from 'react'
import { ContextMenuHost } from '@/components/ContextMenu'
import { LoadingScreen } from '@/app/LoadingScreen'
import { PlatformProvider, COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'
import { useAccount } from '@/features/settings/useAccount'
import { attachMachinesListener } from '@/stores/machines'
import { attachRemoteLanesListener } from '@/stores/remoteLanes'
import { attachPiCommandsListener } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { loadBundledFonts } from '@/lib/fonts'
import { TooltipProvider } from '@/components/Tooltip'
import { PromptHost } from '@/components/PromptHost'
import { ExtensionDialogHost, ToastHost } from '@/features/extension-ui/ExtensionUiHosts'
import { CompactSignIn } from './CompactSignIn'
import { clearCompactUi, waitForCompactCleanup } from './compactLifecycle'
import { useBrowserNavigation } from './useBrowserNavigation'
import { useCompactViewport } from './useCompactViewport'
import { BrowserShell } from './BrowserShell'

/** Mount only after the real browser adapter has been installed and started. */
export function CompactApp(): React.JSX.Element {
  const formFactor = useCompactViewport()
  const account = useAccount()
  const appearance = useClientAppearance()
  const signedIn = account.view?.account.status === 'signed-in'
  return (
    <PlatformProvider value={formFactor === 'compact' ? COMPACT_PLATFORM : WIDE_BROWSER_PLATFORM}>
      <TooltipProvider>
        {appearance !== 'ready' ? (
          <LoadingScreen
            message="Preparing your workspace…"
            error={appearance === 'error' ? 'Couldn’t load your preferences.' : undefined}
            onRetry={() => window.location.reload()}
          />
        ) : signedIn ? (
          <AuthenticatedCompact
            key={
              account.view?.account.status === 'signed-in'
                ? JSON.stringify([account.generation, account.view.account.user])
                : ''
            }
          />
        ) : (
          <CompactSignIn view={account.view} error={account.error} />
        )}
      </TooltipProvider>
    </PlatformProvider>
  )
}

/** Match native startup: settle font metrics and preferences before feature views mount. */
function useClientAppearance(): 'loading' | 'ready' | 'error' {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    let active = true
    void Promise.all([loadBundledFonts(), useSettingsStore.getState().hydrate()]).then(
      () => {
        if (active) setState('ready')
      },
      () => {
        if (active) setState('error')
      },
    )
    return () => {
      active = false
    }
  }, [])
  return state
}

function AuthenticatedCompact(): React.JSX.Element {
  const navigation = useBrowserNavigation()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    let detach: (() => void) | undefined
    void waitForCompactCleanup().then(() => {
      if (!active) return
      const offMachines = attachMachinesListener()
      const offLanes = attachRemoteLanesListener()
      const offCommands = attachPiCommandsListener()
      detach = () => {
        offCommands()
        offLanes()
        offMachines()
      }
      setReady(true)
    })
    return () => {
      active = false
      detach?.()
      clearCompactUi()
    }
  }, [])
  if (!ready) return <LoadingScreen message="Connecting to your machines…" />
  return (
    <NavigationProvider value={navigation}>
      <BrowserShell pending={navigation.pending} />
      <ContextMenuHost />
      <ExtensionDialogHost />
      <PromptHost />
      <ToastHost />
    </NavigationProvider>
  )
}
