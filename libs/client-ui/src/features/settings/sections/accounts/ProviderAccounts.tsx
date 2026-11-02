import { TooltipButton } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { TerminalView } from '@/features/terminal/TerminalView'
import { useSettingsUiStore } from '../../settingsUiStore'
import { SectionStatusNotice } from '../sectionStatus'
import type { ProviderAccountsSource } from './accountsModel'
import { ProviderList } from './ProviderList'

/**
 * Settings → Accounts: signing pi into a provider instead of pasting an API
 * key, on every machine. On This Mac the sign-in runs in the app; on a Host it
 * runs in a private terminal there. Claude Code accounts have their own page.
 */
export function ProviderAccounts({
  source,
}: {
  source: ProviderAccountsSource
}): React.JSX.Element {
  const { status, terminal } = source
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Accounts</h2>
      <p className="text-text-secondary mt-1 text-base">
        Sign pi into a provider instead of pasting an API key. Signed-in providers put their models
        in the picker for every session.
        {source.caps.signIn === 'terminal' &&
          ' Sign-in runs in a private terminal on this machine, and the credential stays there.'}
      </p>
      {status === 'loading' ? (
        <div className="text-text-secondary mt-4 text-base">Checking…</div>
      ) : status === 'ready' ? (
        <ProviderList source={source} />
      ) : (
        <div className="mt-4">
          <SectionStatusNotice status={status} title="Could not read this machine’s providers" />
        </div>
      )}
      {source.error && <p className="text-danger mt-3 text-base">{source.error}</p>}
      <div className="mt-5 flex items-center gap-4">
        {source.refresh && (
          <TooltipButton
            onClick={source.refresh}
            className="text-text-secondary hover:text-text text-base"
          >
            Refresh
          </TooltipButton>
        )}
        {terminal && terminal.ptyId === null && (
          <TooltipButton
            onClick={terminal.open}
            className="text-text-tertiary hover:text-text text-base"
          >
            Open pi’s login terminal
          </TooltipButton>
        )}
      </div>
      {terminal?.ptyId && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-text-secondary text-base">
              pi’s own <span className="font-mono">/login</span>. Type it and press Enter.
            </p>
            <TooltipButton
              onClick={terminal.close}
              className="text-text-secondary hover:text-text text-base"
            >
              Done
            </TooltipButton>
          </div>
          <div className="border-border h-64 overflow-hidden rounded-lg border p-2">
            <TerminalView ptyId={terminal.ptyId} visible />
          </div>
        </div>
      )}
      <ClaudeCodeLink />
    </div>
  )
}

/** Claude Code accounts live on their own page, nested under Extensions. */
function ClaudeCodeLink(): React.JSX.Element {
  const setTab = useSettingsUiStore((s) => s.setTab)
  return (
    <section className="border-border mt-6 flex items-center gap-4 rounded-lg border px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">Claude Code</div>
        <p className="text-text-secondary text-sm">
          Claude accounts, their routing and the provider&apos;s health have their own page under
          Extensions.
        </p>
      </div>
      <Button size="sm" onClick={() => setTab('claude-provider')}>
        Open Claude Code
      </Button>
    </section>
  )
}
