import clsx from 'clsx'
import { MIN_CLAUDE_CONTEXT_VERSION } from '@shared/models'
import { Button } from '@/components/form'
import { JobOutput } from '../../JobOutput'

/** Claude Code line the extension is tested against (see the fork's CI). */
const TESTED_CLI_LINE = '2.1'

/** What the machine reports about the pi-claude-cli provider and the `claude` CLI. */
export interface ClaudeHealthModel {
  provider: 'checking' | 'missing' | 'declared' | 'installed' | 'outdated'
  /** The provider package, when the machine reports which copy it has. */
  package?: { name: string; version?: string; scope?: string }
  /** A newer published provider, when the machine checks versions. */
  providerLatest?: string | null
  cli: 'checking' | 'missing' | 'installed'
  cliVersion?: string
  cliPath?: string
  /** A newer published CLI, when the machine checks versions. */
  cliLatest?: string | null
}

/** One streamed package job: an install, an update or the end-to-end test. */
export interface HealthJob {
  running: boolean
  output: string
  exitCode: number | null
}

export type ClaudeInstallable = 'provider' | 'cli'

/**
 * The provider package and the CLI, each with the one action that fixes it:
 * install, update, or (on a machine that installs through a reviewed task)
 * install the CLI too. Props only.
 */
/** One health fact: a dot, what it is, what the machine reports, and the one fix. */
function StatusRow({
  label,
  ok,
  detail,
  action,
}: {
  label: string
  ok: boolean
  detail: string
  action?: { label: string; disabled: boolean; run: () => void }
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        className={clsx('h-2 w-2 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-warning')}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{label}</div>
        <div className="text-text-tertiary truncate font-mono text-sm">{detail}</div>
      </div>
      {action && (
        <Button size="sm" disabled={action.disabled} onClick={action.run} className="shrink-0">
          {action.label}
        </Button>
      )}
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
      <Button variant="primary" size="sm" onClick={onUpdate} disabled={running}>
        {running ? 'Updating…' : 'Update'}
      </Button>
    </div>
  )
}

interface HealthProps {
  health: ClaudeHealthModel
  /** Installs run as a reviewed task on the machine, which can also install the CLI. */
  reviewed: boolean
  busy: boolean
  onInstall: (what: ClaudeInstallable) => void
  onUpdate: (what: ClaudeInstallable) => void
}

function providerDetail({ provider, package: pkg }: ClaudeHealthModel): string {
  if (provider === 'checking') return 'checking…'
  if (provider === 'missing') return 'not in pi packages'
  if (provider === 'declared') return 'declared — installs on next session start'
  if (!pkg) return '@saccolabs/pi-claude-cli'
  return pkg.version ? `${pkg.name} v${pkg.version}${pkg.scope ? ` (${pkg.scope})` : ''}` : pkg.name
}

function cliDetail({ cli, cliPath, cliVersion }: ClaudeHealthModel, reviewed: boolean): string {
  if (cli === 'checking') return 'checking…'
  if (cli === 'installed')
    return cliPath
      ? `${cliVersion ? `v${cliVersion}` : 'version unknown'} at ${cliPath}`
      : 'installed'
  return reviewed
    ? 'not installed'
    : 'not found on your login-shell PATH — see “When it fails” below'
}

/** The provider package and the CLI, each with the one action that fixes it. */
function HealthRows({
  health,
  reviewed,
  busy,
  onInstall,
  onUpdate,
}: HealthProps): React.JSX.Element {
  const { provider, cli } = health
  const fix = provider === 'missing' || provider === 'outdated'
  return (
    <div className="border-border mt-2 divide-y rounded-lg border">
      <StatusRow
        label="Extension package"
        ok={provider === 'installed'}
        detail={providerDetail(health)}
        action={
          fix
            ? {
                label: provider === 'missing' ? 'Install provider' : 'Update provider',
                disabled: busy,
                run: () => (provider === 'missing' ? onInstall('provider') : onUpdate('provider')),
              }
            : undefined
        }
      />
      {health.providerLatest && !fix && (
        <UpdateRow
          latest={health.providerLatest}
          note="pi never moves an installed package on its own — update, then restart sessions."
          running={busy}
          onUpdate={() => onUpdate('provider')}
        />
      )}
      <StatusRow
        label="claude CLI"
        ok={cli === 'installed'}
        detail={cliDetail(health, reviewed)}
        action={
          cli === 'missing' && reviewed
            ? { label: 'Install Claude Code', disabled: busy, run: () => onInstall('cli') }
            : undefined
        }
      />
      {health.cliLatest && (
        <UpdateRow
          latest={health.cliLatest}
          note="The CLI never updates itself mid-session — update, then restart sessions."
          running={busy}
          onUpdate={() => onUpdate('cli')}
        />
      )}
    </div>
  )
}

/** Health, props only. A machine that installs by reviewed task can install the CLI too. */
export function ClaudeHealth(props: HealthProps): React.JSX.Element {
  const { health } = props
  const pkg = health.package
  return (
    <>
      <h3 className="mt-5 text-lg font-semibold">Health</h3>
      <HealthRows {...props} />
      {health.provider === 'outdated' && pkg && (
        <p className="text-warning mt-2 text-sm" data-testid="claude-provider-too-old">
          Claude sessions need {pkg.name} {MIN_CLAUDE_CONTEXT_VERSION} or newer; this is{' '}
          {pkg.version ?? 'an unknown version'}. Update it, then reopen your Claude sessions.
        </p>
      )}
      {health.cliVersion && !health.cliVersion.startsWith(`${TESTED_CLI_LINE}.`) && (
        <p className="text-warning mt-2 text-sm">
          This extension is tested against Claude Code {TESTED_CLI_LINE}.x; you have{' '}
          {health.cliVersion}. It may still work — run the test below.
        </p>
      )}
    </>
  )
}

/** One tiny print-mode prompt through pi on the Claude provider, and its verdict. */
export function ClaudeProof({
  job,
  disabled,
  onTest,
}: {
  job: HealthJob
  disabled: boolean
  onTest: () => void
}): React.JSX.Element {
  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">Prove it end to end</h3>
      <p className="text-text-secondary mt-1 text-base">
        Runs one tiny print-mode prompt through pi with the{' '}
        <span className="font-mono">pi-claude-cli/claude-haiku-4-5</span> model — exercising the
        CLI, your login, and the extension. Uses a negligible amount of plan quota.
      </p>
      <Button
        variant="primary"
        onClick={onTest}
        disabled={job.running || disabled}
        className="mt-2.5"
      >
        {job.running ? 'Testing…' : 'Test provider'}
      </Button>
      <JobOutput running={job.running} output={job.output} exitCode={job.exitCode} />
      {job.exitCode === 0 && job.output.includes('phosphor-provider-ok') && (
        <p className="text-success mt-2 text-base">
          Round-trip confirmed — the provider is fully working.
        </p>
      )}
    </>
  )
}

/** What usually goes wrong, and the fix. The first item depends on how the CLI is installed. */
export function ClaudeTroubleshooting({ reviewed }: { reviewed: boolean }): React.JSX.Element {
  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">When it fails</h3>
      <ul className="text-text-secondary mt-1 list-disc space-y-1 pl-5 text-base">
        {!reviewed && (
          <li>
            <span className="font-mono">claude</span> missing: GUI launches only see your
            login-shell PATH. Install it with{' '}
            <span className="font-mono">curl -fsSL https://claude.ai/install.sh | bash</span>{' '}
            (native, lands in <span className="font-mono">~/.local/bin</span>) or{' '}
            <span className="font-mono">npm install -g @anthropic-ai/claude-code</span>, then make
            sure that directory is on the PATH your shell profile exports.
          </li>
        )}
        <li>
          A new model is missing from the picker: updating the CLI will not add it. The{' '}
          <span className="font-mono">pi-claude-cli</span> model list comes from pi&apos;s own
          bundled Anthropic catalogue, so it moves when <span className="font-mono">pi</span>{' '}
          updates — not when Claude Code does.
        </li>
        <li>
          Logged out or expired: use <strong>Sign in again</strong> on the account above.
        </li>
        <li>
          Empty replies after a Claude Code update: the CLI&apos;s stream format may have moved —
          check the extension repo for a newer release.
        </li>
      </ul>
    </>
  )
}
