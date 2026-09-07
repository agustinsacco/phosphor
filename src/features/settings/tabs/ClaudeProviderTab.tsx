import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import type {
  ClaudeAccountSessions,
  ClaudeAccountsResult,
  ClaudeAccountView,
  ClaudeLoginState,
  ClaudeRoutingMode,
  ClaudeStatus,
  PiPackageEntry,
} from '@shared/models'
import { Button, TextInput } from '@/components/form'
import { ChevronIcon, Spinner } from '@/components/icons'
import { usePackageJob } from '../usePackageJob'
import { isNewerVersion } from '@shared/version'
import { JobOutput } from '../JobOutput'
import { ClaudeAccountPanel } from './ClaudeAccountPanel'
import { usageTextClass, windowResetLabel } from '@/lib/claudeUsage'
import { isValidAutocompactValue } from '@/lib/claudeAutocompact'
import { useSessionsStore } from '@/stores/sessions'

/** Claude Code line the extension is tested against (see the fork's CI). */
const TESTED_CLI_LINE = '2.1'

/**
 * Settings → Claude Code: health and proof for the pi-claude-cli provider.
 * Shown only while the package is in pi's packages (see SettingsModal).
 */
export function ClaudeProviderTab(): React.JSX.Element {
  const [pkg, setPkg] = useState<PiPackageEntry | null | undefined>(undefined)
  const [latest, setLatest] = useState<string | null>(null)
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [cliLatest, setCliLatest] = useState<string | null>(null)
  const [login, setLogin] = useState<ClaudeLoginState | null>(null)
  const [accounts, setAccounts] = useState<ClaudeAccountsResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [entries, claudeState, accountState] = await Promise.all([
      window.pidex.invoke('packages:list'),
      window.pidex.invoke('packages:claudeStatus'),
      window.pidex.invoke('claude:accounts'),
    ])
    const entry = entries.find((e) => e.spec.includes('pi-claude-cli')) ?? null
    setPkg(entry)
    setStatus(claudeState)
    setAccounts(accountState)
    // Both version checks hit the network, so neither blocks the health rows.
    if (entry) {
      void window.pidex
        .invoke('packages:checkUpdates')
        .then((map) => setLatest(map[entry.spec] ?? null))
        .catch(() => setLatest(null))
    }
    void window.pidex
      .invoke('packages:claudeCliLatest')
      .then(setCliLatest)
      .catch(() => setCliLatest(null))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Sign-in progress is an event, not a return value: the middle of it is a
  // human in a browser. Terminal phases re-read status so the row shows the
  // account that is actually live, not the one we hoped for.
  useEffect(
    () =>
      window.pidex.onClaudeLoginState((state) => {
        setLogin(state.phase === 'signed-in' || state.phase === 'cancelled' ? null : state)
        if (state.phase === 'signed-in' || state.phase === 'cancelled') void refresh()
      }),
    [refresh],
  )

  const updateJob = usePackageJob(() => void refresh())
  const cliUpdateJob = usePackageJob(() => void refresh())
  const testJob = usePackageJob()
  const updatable =
    latest !== null && pkg?.version !== undefined && isNewerVersion(latest, pkg.version)
  const binaryOk = status?.binary.found === true
  const cliVersion = status?.binary.version
  const cliUpdatable =
    cliLatest !== null && cliVersion !== undefined && isNewerVersion(cliLatest, cliVersion)

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Claude Code provider</h2>
      <p className="text-text-secondary mt-1 text-base">
        Routes model calls through the Claude Code CLI, billing your Claude Pro/Max plan. Claude
        models appear in the model picker under the <span className="font-mono">pi-claude-cli</span>{' '}
        provider.
      </p>

      <h3 className="mt-5 text-lg font-semibold">Health</h3>
      <div className="border-border mt-2 divide-y rounded-lg border">
        <StatusRow
          label="Extension package"
          ok={pkg != null && pkg.installed}
          detail={
            pkg === undefined
              ? 'checking…'
              : pkg === null
                ? 'not in pi packages — add it from the Extensions tab'
                : pkg.installed
                  ? `${pkg.name} v${pkg.version ?? '?'} (${pkg.scope})`
                  : 'declared — installs on next session start'
          }
        />
        {updatable && (
          <UpdateRow
            latest={latest!}
            note="pi never moves an installed package on its own — update, then restart sessions."
            running={updateJob.running}
            onUpdate={() =>
              void updateJob.start(() =>
                window.pidex.invoke('packages:run', 'update', pkg!.spec, 'global', undefined),
              )
            }
          />
        )}
        <StatusRow
          label="claude CLI"
          ok={binaryOk}
          detail={
            status === null
              ? 'checking…'
              : binaryOk
                ? `${cliVersion ? `v${cliVersion}` : 'version unknown'} at ${status.binary.path}`
                : 'not found on your login-shell PATH — see “When it fails” below'
          }
        />
        {cliUpdatable && (
          <UpdateRow
            latest={cliLatest!}
            note="The CLI never updates itself mid-session — update, then restart sessions."
            running={cliUpdateJob.running}
            onUpdate={() =>
              void cliUpdateJob.start(() => window.pidex.invoke('packages:updateClaudeCli'))
            }
          />
        )}
      </div>
      {status?.binary.version && !status.binary.version.startsWith(`${TESTED_CLI_LINE}.`) && (
        <p className="text-warning mt-2 text-sm">
          This extension is tested against Claude Code {TESTED_CLI_LINE}.x; you have{' '}
          {status.binary.version}. It may still work — run the test below.
        </p>
      )}

      <AccountsSection
        accounts={accounts}
        login={login}
        disabled={!binaryOk}
        onChanged={() => void refresh()}
        onAccounts={setAccounts}
        onLoginState={setLogin}
      />

      <ContextWindowSection />

      <h3 className="mt-6 text-lg font-semibold">Prove it end to end</h3>
      <p className="text-text-secondary mt-1 text-base">
        Runs one tiny print-mode prompt through pi with the{' '}
        <span className="font-mono">pi-claude-cli/claude-haiku-4-5</span> model — exercising the
        CLI, your login, and the extension. Uses a negligible amount of plan quota.
      </p>
      <Button
        variant="primary"
        onClick={() => void testJob.start(() => window.pidex.invoke('packages:testClaudeProvider'))}
        disabled={testJob.running || !binaryOk}
        className="mt-2.5"
      >
        {testJob.running ? 'Testing…' : 'Test provider'}
      </Button>
      <JobOutput
        running={updateJob.running}
        output={updateJob.output}
        exitCode={updateJob.exitCode}
      />
      <JobOutput
        running={cliUpdateJob.running}
        output={cliUpdateJob.output}
        exitCode={cliUpdateJob.exitCode}
      />
      <JobOutput running={testJob.running} output={testJob.output} exitCode={testJob.exitCode} />
      {testJob.exitCode === 0 && testJob.output.includes('pidex-provider-ok') && (
        <p className="text-success mt-2 text-base">
          Round-trip confirmed — the provider is fully working.
        </p>
      )}

      <h3 className="mt-6 text-lg font-semibold">When it fails</h3>
      <ul className="text-text-secondary mt-1 list-disc space-y-1 pl-5 text-base">
        <li>
          <span className="font-mono">claude</span> missing: GUI launches only see your login-shell
          PATH. Install it with{' '}
          <span className="font-mono">curl -fsSL https://claude.ai/install.sh | bash</span> (native,
          lands in <span className="font-mono">~/.local/bin</span>) or{' '}
          <span className="font-mono">npm install -g @anthropic-ai/claude-code</span>, then make
          sure that directory is on the PATH your shell profile exports.
        </li>
        <li>
          A new model is missing from the picker: updating the CLI will not add it. The{' '}
          <span className="font-mono">pi-claude-cli</span> model list comes from pi&apos;s own
          bundled Anthropic catalogue, so it moves when <span className="font-mono">pi</span>{' '}
          updates — not when Claude Code does.
        </li>
        <li>
          Logged out or expired: use <strong>Sign in again</strong> on the account above. It drives{' '}
          <span className="font-mono">claude auth login</span> for you — no terminal needed.
        </li>
        <li>
          Empty replies after a Claude Code update: the CLI&apos;s stream format may have moved —
          check the extension repo for a newer release.
        </li>
      </ul>
    </div>
  )
}

/** Which account the standalone usage panel and one-shot runs report on. */
function primaryAccountId(accounts: ClaudeAccountsResult | null): string | undefined {
  if (!accounts) return undefined
  const pinned = accounts.prefs.pinnedId
  if (pinned && accounts.prefs.accounts.some((a) => a.id === pinned)) return pinned
  return accounts.prefs.accounts[0]?.id
}

const ROUTING_OPTIONS: { value: ClaudeRoutingMode; title: string; detail: string }[] = [
  {
    value: 'specific',
    title: 'One account',
    detail: 'Every session bills the account you pick below.',
  },
  {
    value: 'ordered',
    title: 'In order, top to bottom',
    detail:
      'A new session starts on the highest account that still has 5-hour quota. Reorder with the arrows.',
  },
  {
    value: 'round-robin',
    title: 'Round robin',
    detail: 'Each new session takes the next account in the list, spreading load across plans.',
  },
]

/**
 * Claude logins, in routing order, and the rule that picks between them.
 *
 * This is the row that used to say “switching accounts is sign-out then
 * sign-in”. It no longer is: the CLI scopes its keychain entry by
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so pidex keeps one credential directory
 * per account and hands the right one to each session's `pi` spawn.
 *
 * Two things the UI has to be honest about, because both surprise people:
 * the account is fixed when a session STARTS (the CLI process is parked for
 * the session's life, so there is no mid-conversation failover), and the
 * “out of quota” marks come from a cached `/usage` reading, not a live one.
 */
function AccountsSection({
  accounts,
  login,
  disabled,
  onChanged,
  onAccounts,
  onLoginState,
}: {
  accounts: ClaudeAccountsResult | null
  login: ClaudeLoginState | null
  disabled: boolean
  onChanged: () => void
  onAccounts: (accounts: ClaudeAccountsResult) => void
  onLoginState: (state: ClaudeLoginState | null) => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ClaudeAccountSessions>({})
  const inFlight = login !== null
  const prefs = accounts?.prefs
  const views = accounts?.views ?? []

  // Re-read on every change to the live set, which is also what a move
  // produces: the moved lane is a new pidex session id on a new account.
  const liveKey = useSessionsStore((s) => Object.keys(s.live).sort().join(','))
  useEffect(() => {
    void window.pidex
      .invoke('claude:accountSessions')
      .then(setSessions)
      .catch(() => setSessions({}))
  }, [liveKey])

  const start = async (accountId?: string): Promise<void> => {
    setCode('')
    onLoginState({ phase: 'starting' })
    try {
      await window.pidex.invoke('claude:startLogin', accountId)
    } catch (caught) {
      onLoginState({
        phase: 'error',
        message: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }

  const submit = async (): Promise<void> => {
    if (!code.trim()) return
    try {
      await window.pidex.invoke('claude:submitCode', code.trim())
      setCode('')
    } catch (caught) {
      onLoginState({
        phase: 'error',
        message: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }

  const mutate = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const move = (index: number, delta: number): void => {
    const ids = views.map((v) => v.account.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    const reordered = [...ids]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved!)
    void mutate(() => window.pidex.invoke('claude:reorderAccounts', reordered))
  }

  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">Accounts</h3>
      <p className="text-text-secondary mt-1 text-base">
        Each account keeps its own credential, so they sit side by side rather than replacing one
        another. The account is chosen when a session <strong>starts</strong> and stays fixed for
        its whole life — a resumed session always bills the account it began on.
      </p>
      <p className="text-text-secondary mt-1 text-base">
        Open a row for that account&apos;s own plan usage and the sessions spending it. A session on
        a spent account can be restarted there, or moved to another account — both respawn it, so
        the next turn re-reads the whole thread and pays for it once.
      </p>
      <p className="text-text-tertiary mt-1 text-sm">
        Adding an account opens Claude&apos;s sign-in page. If your browser signs you straight back
        into the account you already have, sign out at claude.ai first — signing in as an email that
        is already listed re-authenticates that row instead of adding a second one.
      </p>

      <div className="border-border mt-2 divide-y rounded-lg border">
        {accounts === null ? (
          <div className="text-text-secondary flex items-center gap-2 px-3.5 py-2.5 text-base">
            <Spinner /> Reading your Claude logins…
          </div>
        ) : views.length === 0 ? (
          <div className="text-text-secondary px-3.5 py-2.5 text-base">
            No Claude account yet. Add one below — it drives{' '}
            <span className="font-mono">claude auth login</span>, no terminal needed.
          </div>
        ) : (
          views.map((view, index) => (
            <AccountRow
              key={view.account.id}
              view={view}
              index={index}
              count={views.length}
              views={views}
              sessionIds={sessions[view.account.id] ?? []}
              expanded={expandedId === view.account.id}
              onToggle={() =>
                setExpandedId((current) => (current === view.account.id ? null : view.account.id))
              }
              pinned={prefs?.mode === 'specific' && primaryAccountId(accounts) === view.account.id}
              selectable={prefs?.mode === 'specific'}
              busy={busy || inFlight}
              onMove={move}
              onPin={() =>
                void mutate(() =>
                  window.pidex.invoke('claude:setRouting', 'specific', view.account.id),
                )
              }
              onReauth={() => void start(view.account.id)}
              onRemove={() =>
                void mutate(() => window.pidex.invoke('claude:removeAccount', view.account.id))
              }
            />
          ))
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        {inFlight ? (
          <button
            onClick={() => {
              void window.pidex.invoke('claude:cancelLogin')
              onLoginState(null)
            }}
            className="text-text-secondary hover:text-text text-base"
          >
            Cancel sign-in
          </button>
        ) : (
          <Button variant="secondary" disabled={disabled || busy} onClick={() => void start()}>
            Add account
          </Button>
        )}
        <button
          onClick={() =>
            void mutate(async () =>
              onAccounts(await window.pidex.invoke('claude:refreshAccountUsage')),
            )
          }
          disabled={disabled || busy || views.length === 0}
          className="text-text-secondary hover:text-text text-base disabled:opacity-50"
        >
          Refresh usage
        </button>
      </div>

      <LoginProgress code={code} login={login} onCode={setCode} onSubmit={() => void submit()} />

      {views.length > 0 && (
        <>
          <h4 className="mt-5 text-base font-semibold">Route new sessions</h4>
          <div className="border-border mt-2 divide-y rounded-lg border">
            {ROUTING_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="hover:bg-surface-raised flex cursor-pointer items-start gap-3 px-3.5 py-2.5"
              >
                <input
                  type="radio"
                  name="claude-routing"
                  className="accent-accent mt-1"
                  checked={prefs?.mode === option.value}
                  disabled={busy}
                  onChange={() =>
                    void mutate(() =>
                      window.pidex.invoke(
                        'claude:setRouting',
                        option.value,
                        primaryAccountId(accounts),
                      ),
                    )
                  }
                />
                <div className="min-w-0">
                  <div className="text-base font-medium">{option.title}</div>
                  <div className="text-text-tertiary text-sm">{option.detail}</div>
                </div>
              </label>
            ))}
          </div>
          {prefs?.mode !== 'specific' && (
            <p className="text-text-tertiary mt-2 text-sm">
              “Out of quota” is read from each account&apos;s cached{' '}
              <span className="font-mono">/usage</span>, refreshed in the background after a session
              starts. Press <strong>Refresh usage</strong> to make the next choice use live numbers.
            </p>
          )}
        </>
      )}
    </>
  )
}

/**
 * One account: identity, quota, order, its two destructive-ish buttons — and,
 * when opened, that account's own usage and the sessions spending it.
 *
 * The disclosure is what makes this a gateway rather than a list. Usage is
 * per credential, so a single panel could only ever describe one of these
 * rows; the numbers now sit under the account they belong to, and the lanes
 * billing it sit under the same fold.
 */
function AccountRow({
  view,
  index,
  count,
  views,
  sessionIds,
  expanded,
  onToggle,
  pinned,
  selectable,
  busy,
  onMove,
  onPin,
  onReauth,
  onRemove,
}: {
  view: ClaudeAccountView
  index: number
  count: number
  views: ClaudeAccountView[]
  sessionIds: string[]
  expanded: boolean
  onToggle: () => void
  pinned: boolean
  selectable: boolean
  busy: boolean
  onMove: (index: number, delta: number) => void
  onPin: () => void
  onReauth: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { account, auth, usage, cooldownUntil } = view
  const signedIn = auth.loggedIn === true
  const fiveHour = usage?.windows.find((w) => w.kind === 'five_hour')
  const detail = [
    auth.email ?? account.email ?? (signedIn ? 'logged in' : 'signed out'),
    auth.plan ?? account.plan,
    auth.organization ?? account.organization,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-start gap-3">
        {selectable ? (
          <input
            type="radio"
            name="claude-pinned-account"
            aria-label={`Use ${account.label} for new sessions`}
            className="accent-accent mt-1.5"
            checked={pinned}
            disabled={busy}
            onChange={onPin}
          />
        ) : (
          <span
            className={clsx(
              'mt-2 h-2 w-2 shrink-0 rounded-full',
              signedIn ? 'bg-success' : 'bg-warning',
            )}
            aria-hidden
          />
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-1.5 text-base font-medium">
            <ChevronIcon expanded={expanded} className="text-text-tertiary" />
            {account.label}
            {!signedIn && <span className="text-warning text-sm">needs sign-in</span>}
            <span className="text-text-tertiary text-sm font-normal">
              {sessionIds.length === 0
                ? 'no live session'
                : sessionIds.length === 1
                  ? '1 live session'
                  : `${sessionIds.length} live sessions`}
            </span>
          </div>
          <div className="text-text-tertiary truncate font-mono text-sm">{detail}</div>
          {fiveHour && (
            <div className={clsx('mt-0.5 font-mono text-sm', usageTextClass(fiveHour.percentUsed))}>
              5-hour {Math.round(fiveHour.percentUsed)}% used
              {windowResetLabel(fiveHour.resetsAt)
                ? ` · ${windowResetLabel(fiveHour.resetsAt)}`
                : ''}
            </div>
          )}
          {cooldownUntil !== null && (
            <div className="text-warning mt-0.5 text-sm">
              Skipped by routing until this window resets.
            </div>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => onMove(index, -1)}
            disabled={busy || index === 0}
            aria-label={`Move ${account.label} up`}
            className="text-text-secondary hover:text-text px-1 text-base disabled:opacity-30"
          >
            ↑
          </button>
          <button
            onClick={() => onMove(index, 1)}
            disabled={busy || index === count - 1}
            aria-label={`Move ${account.label} down`}
            className="text-text-secondary hover:text-text px-1 text-base disabled:opacity-30"
          >
            ↓
          </button>
          <button
            onClick={onReauth}
            disabled={busy}
            className="text-text-secondary hover:text-text text-base disabled:opacity-50"
          >
            Sign in again
          </button>
          <button
            onClick={onRemove}
            disabled={busy}
            className="text-danger text-base hover:underline disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>

      {expanded && (
        <ClaudeAccountPanel accountId={account.id} views={views} sessionIds={sessionIds} />
      )}
    </div>
  )
}

/** The browser handoff: spinner, error, and the code the user pastes back. */
function LoginProgress({
  code,
  login,
  onCode,
  onSubmit,
}: {
  code: string
  login: ClaudeLoginState | null
  onCode: (code: string) => void
  onSubmit: () => void
}): React.JSX.Element | null {
  if (login === null) return null
  return (
    <div>
      {login.phase === 'starting' && (
        <div className="text-text-secondary mt-3 flex items-center gap-2 text-sm">
          <Spinner />
          Starting the Claude CLI’s sign-in…
        </div>
      )}

      {login.phase === 'finishing' && (
        <div className="text-text-secondary mt-3 flex items-center gap-2 text-sm">
          <Spinner />
          Finishing sign-in…
        </div>
      )}

      {login.phase === 'error' && <p className="text-danger mt-3 text-sm">{login.message}</p>}

      {login.phase === 'awaiting-code' && (
        <div className="border-border bg-surface-raised mt-3 rounded-md border p-3">
          {login.invalidCode && (
            <p className="text-danger text-sm">
              That code wasn’t accepted. Use the fresh link below — the earlier one has expired.
            </p>
          )}
          {/* The paste-back step is the one people miss: the CLI's OAuth
              redirect lands on a page showing a code, and nothing on screen
              says it has to come back here. */}
          <p className="text-text-secondary text-sm">
            Finish in the browser, then paste the code Claude shows you:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <TextInput
              autoFocus
              value={code}
              onChange={(event) => onCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSubmit()
              }}
              placeholder="Paste code"
              className="min-w-0 flex-1 rounded-md font-mono"
            />
            <Button variant="primary" disabled={!code.trim()} onClick={onSubmit}>
              Continue
            </Button>
          </div>
          <button
            onClick={() => void window.pidex.invoke('app:openExternal', login.url)}
            className="text-accent mt-2.5 block text-sm hover:underline"
          >
            Browser didn’t open? Open the sign-in page
          </button>
        </div>
      )}
    </div>
  )
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean
  detail: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        className={clsx('h-2 w-2 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-warning')}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-base font-medium">{label}</div>
        <div className="text-text-tertiary truncate font-mono text-sm">{detail}</div>
      </div>
    </div>
  )
}

/**
 * "vX is available" + an Update button, tucked under the row it belongs to.
 *
 * Shared by the extension package and the `claude` CLI because both go stale
 * the same way: nothing moves them on its own, and the tab reads green while
 * they sit months behind.
 */
function UpdateRow({
  latest,
  note,
  running,
  onUpdate,
}: {
  latest: string
  note: string
  running: boolean
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <div className="border-border flex items-center justify-between gap-3 border-t px-3.5 py-2.5">
      <div className="text-base">
        <span className="text-accent font-medium">v{latest} is available.</span>{' '}
        <span className="text-text-secondary">{note}</span>
      </div>
      <button
        onClick={onUpdate}
        disabled={running}
        className="bg-accent hover:bg-accent-hover text-accent-text shrink-0 rounded-md px-2.5 py-1 text-base font-medium transition-colors disabled:opacity-50"
      >
        {running ? 'Updating…' : 'Update'}
      </button>
    </div>
  )
}

/**
 * Presets for the auto-compact window. `''` is "provider default": the env
 * var is not set at all and pi-claude-cli applies its own 200k cap.
 */
const AUTOCOMPACT_PRESETS = [
  {
    value: '',
    title: 'Default — 200k tokens',
    detail:
      'The provider caps the Claude Code session at 200k and the CLI compacts it in-session. ' +
      'Matches the budget these models run under everywhere the 1M beta is off.',
  },
  {
    value: '400k',
    title: '400k tokens',
    detail:
      'Roomier before each compaction, at roughly double the per-request cache cost once a ' +
      'session grows past 200k.',
  },
  {
    value: 'auto',
    title: 'Model maximum',
    detail:
      'The CLI decides — on 1M-context models a long-lived session can grow toward a million ' +
      'tokens, and every request re-reads all of it. The pre-0.5.0 behaviour.',
  },
] as const

/**
 * Settings → Claude Code → Context window: the auto-compact window for
 * pi-claude-cli sessions (PI_CLAUDE_CLI_AUTOCOMPACT). Applies to sessions
 * started after the change; running sessions keep their window.
 */
function ContextWindowSection(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [customDraft, setCustomDraft] = useState('')
  const [customError, setCustomError] = useState(false)

  useEffect(() => {
    void window.pidex.invoke('app:getPrefs').then((prefs) => {
      const stored = prefs.claudeAutocompact ?? ''
      setValue(stored)
      if (!AUTOCOMPACT_PRESETS.some((p) => p.value === stored)) setCustomDraft(stored)
    })
  }, [])

  const save = useCallback((next: string): void => {
    setValue(next)
    setCustomError(false)
    void window.pidex.invoke('app:setClaudeAutocompact', next)
  }, [])

  const commitCustom = useCallback((): void => {
    const draft = customDraft.trim()
    if (draft === '') {
      save('')
      return
    }
    if (!isValidAutocompactValue(draft)) {
      setCustomError(true)
      return
    }
    save(draft)
  }, [customDraft, save])

  const isPreset = AUTOCOMPACT_PRESETS.some((p) => p.value === value)

  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">Context window</h3>
      <p className="text-text-secondary mt-1 text-base">
        How large a Claude Code session may grow before the CLI compacts it. Smaller windows cost
        less (every request re-reads the whole context) and keep the model focused; compaction
        summarizes older turns in place. Applies to sessions you start from now on.
      </p>
      <div className="mt-2.5 space-y-2" role="radiogroup" aria-label="Auto-compact window">
        {AUTOCOMPACT_PRESETS.map((preset) => {
          const selected = value === preset.value
          return (
            <button
              key={preset.value || 'default'}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => save(preset.value)}
              className={clsx(
                'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                selected ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-secondary',
              )}
            >
              <span
                className={clsx(
                  'mt-1 h-3 w-3 shrink-0 rounded-full border-2',
                  selected ? 'border-accent bg-accent' : 'border-border-strong',
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="text-text block text-base font-medium">{preset.title}</span>
                <span className="text-text-secondary block text-sm leading-snug">
                  {preset.detail}
                </span>
              </span>
            </button>
          )
        })}
        <div className="flex items-center gap-2.5 px-3 py-1">
          <span
            className={clsx(
              'h-3 w-3 shrink-0 rounded-full border-2',
              !isPreset ? 'border-accent bg-accent' : 'border-border-strong',
            )}
            aria-hidden
          />
          <span className="text-text text-base font-medium">Custom</span>
          <TextInput
            size="sm"
            className="w-32 font-mono"
            placeholder="e.g. 300k"
            aria-label="Custom auto-compact window"
            value={customDraft}
            onChange={(e) => {
              setCustomDraft(e.target.value)
              setCustomError(false)
            }}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCustom()
            }}
          />
          {customError && (
            <span className="text-warning text-sm">
              Use a window from 100k to 1M (e.g. 300k), auto, or off.
            </span>
          )}
        </div>
      </div>
      <p className="text-text-tertiary mt-2 text-sm">
        Needs pi-claude-cli 0.5.0 or newer; older versions ignore the setting. pi&apos;s own
        transcript compaction is configured separately in the Agent tab.
      </p>
    </>
  )
}
