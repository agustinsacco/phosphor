import { useEffect, useRef, useState } from 'react'
import type { MachineView } from '@shared/control-api'
import type { MachineSettingsSection, MachineTaskOp } from '@shared/machine-settings'
import type { ProviderLoginOp } from '@shared/host-protocol-providers'
import { errorText } from '@shared/errors'
import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { useMachinesStore } from '@/stores/machines'
import { TooltipButton } from '@/components/Tooltip'
import { useHostSettings } from './useHostSettings'
import { MachineProviderSettings, type MachinePrograms } from './MachineProviderSettings'
import { MachineConnectorSettings } from './MachineConnectorSettings'
import {
  MachineAdvancedSettings,
  MachineAgentSettings,
  MachineFolderSettings,
  MachineResourceSettings,
} from './MachineExecutionSettings'
import { HostProgramDialog } from './HostProgramDialog'
import { Skeleton, Spinner } from './MachineUi'
import { CopyCommand } from './MachineControls'
import { confirmSettingsNavigation } from './machineSettingsDrafts'

export type MachineSettingsTab = MachineSettingsSection | 'folders'
const SECTIONS: [MachineSettingsTab, string][] = [
  ['providers', 'Providers'],
  ['connectors', 'Connectors'],
  ['agent', 'Agent defaults'],
  ['folders', 'Folders'],
  ['resources', 'Skills & extensions'],
  ['advanced', 'Advanced'],
]
export function MachineSettings({
  machine,
  section,
}: {
  machine: Pick<MachineView, 'id' | 'label'>
  section: MachineSettingsTab
}): React.JSX.Element {
  const [repositoryId, setRepositoryId] = useState<string | undefined>()
  const scoped = section === 'connectors' || section === 'agent'
  const settings = useHostSettings(
    machine.id,
    section === 'folders' ? 'advanced' : section,
    scoped ? repositoryId : undefined,
  )
  const { connection, allowed } = settings
  const [error, setError] = useState<string | null>(null)
  const [accessBusy, setAccessBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [program, setProgram] = useState<{
    ptyId: string
    title: string
    instructions: string
  } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!allowed) setProgram(null)
  }, [allowed])
  const authenticating = settings.data?.providers?.authenticating
  useEffect(() => {
    if (!authenticating || settings.loading) return
    const timer = setTimeout(() => void settings.refresh(), 1500)
    return () => clearTimeout(timer)
  }, [authenticating, settings.data, settings.loading, settings.refresh])
  const terminals =
    allowed &&
    connection?.capabilities.includes('terminal') === true &&
    connection.capabilities.includes('sessions.control')
  async function access() {
    if (
      (await promptChoice({
        title: `Enable settings access for ${machine.label}?`,
        message:
          'This grants this client authority to configure the Host, including reviewed code installs. It reconnects the link; running lanes stay on the Host and resync. Lane control alone does not grant this permission.',
        choices: [{ value: 'enable', label: `Enable for ${machine.label}`, primary: true }],
      })) !== 'enable' ||
      !alive.current
    )
      return
    setAccessBusy(true)
    setError(null)
    try {
      await window.phosphor.invoke('hosts:settingsAccess', machine.id)
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setAccessBusy(false)
    }
  }
  async function openProgram(
    start: () => Promise<{ ptyId: string }>,
    title: string,
    instructions: string,
  ) {
    if (!alive.current || !terminals || starting || program) return
    setStarting(true)
    setError(null)
    try {
      const result = await start()
      if (alive.current) setProgram({ ...result, title, instructions })
      else void window.phosphor.invoke('pty:kill', result.ptyId).catch(() => {})
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setStarting(false)
    }
  }
  async function login(
    provider: string,
    account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount'>,
  ) {
    const name =
      provider === 'claude'
        ? 'Claude Code'
        : (settings.data?.providers?.providers.find((p) => p.id === provider)?.name ?? provider)
    await openProgram(
      () =>
        window.phosphor.invoke('hosts:providerLogin', machine.id, provider, {
          ...account,
          configure: true,
        }),
      'Provider sign-in',
      provider === 'claude'
        ? `Follow ${name}'s sign-in instructions here. Open its link and paste a code if requested; a loopback-only flow may need the browser on ${machine.label}. The CLI stores the account only on that Host.`
        : `pi opens on ${machine.label}. Type /login ${provider}, follow its supported account or code flow, then /quit. To sign out, use /logout ${provider}. API-key-only providers may instead need a credential or environment configuration on the Host.`,
    )
  }
  async function task(input: Omit<MachineTaskOp, 'type'>) {
    const destructive = input.task === 'package.remove' || input.task === 'mcp.logout'
    const description =
      input.task === 'claude.installCli'
        ? 'Download Anthropic’s official https://claude.ai/install.sh over HTTPS and run it as the Host user. No sudo is requested by Phosphor.'
        : input.task === 'claude.installProvider'
          ? 'Run pi install npm:@saccolabs/pi-claude-cli on the Host. npm packages and their install scripts can run code as the Host user.'
          : input.task.startsWith('package.')
            ? `Run pi ${input.task.slice(8)} ${input.name} on the Host. Package install/update scripts can execute code as that user.`
            : input.task === 'folder.trust'
              ? 'Open pi in the selected Host folder to review its trust prompt. Project configuration may contain executable MCP commands. Phosphor does not approve it automatically.'
              : input.task === 'mcp.logout'
                ? `Sign ${input.name} out on this Host only. Existing sessions may lose connector access.`
                : `Run pi mcp login ${input.name} in a private terminal on the Host. Open the link here and follow pi’s supported remote callback/paste instructions.`
    if (
      (await promptChoice({
        title: `${input.task === 'folder.trust' ? 'Review project trust' : destructive ? 'Confirm change' : 'Run setup'} on ${machine.label}?`,
        message: `${description} Running lanes are not restarted.`,
        choices: [
          {
            value: 'run',
            label: destructive ? 'Confirm on this Host' : 'Continue on this Host',
            primary: true,
          },
        ],
      })) !== 'run' ||
      !alive.current
    )
      return
    await openProgram(
      () =>
        window.phosphor.invoke('hosts:machineTask', machine.id, { type: 'machine.task', ...input }),
      input.task === 'mcp.login' ? 'Connector sign-in' : 'Host setup',
      description + (input.task === 'folder.trust' ? ' Quit pi with /quit when finished.' : ''),
    )
  }
  const programs: MachinePrograms = {
    login: (provider, account) => void login(provider, account),
    task: (input) => void task(input),
    busy: starting || !!program,
    available: terminals,
  }
  const select = async (next: MachineSettingsTab) => {
    if (next !== section && !(await confirmSettingsNavigation(machine.id))) return
    setError(null)
    useMachinesStore.getState().show({ kind: 'machine', id: machine.id, settings: next })
  }
  return (
    <section
      aria-label={`Settings on ${machine.label}`}
      className="space-y-4"
      data-testid="machine-settings"
    >
      <div className="border-info/25 bg-info/5 rounded-lg border px-4 py-3">
        <p className="text-lg font-medium">Configuring {machine.label}, not this computer.</p>
        <p className="text-text-secondary mt-1 text-base">
          Credentials stay on this Host. Nothing automatically syncs to another machine.
        </p>
      </div>
      <div className="flex flex-col gap-5 md:flex-row">
        <nav
          aria-label="Machine settings"
          className="flex gap-1 overflow-x-auto md:w-40 md:shrink-0 md:flex-col"
        >
          {SECTIONS.map(([key, title]) => (
            <TooltipButton
              key={key}
              tooltip={`${title} on ${machine.label}`}
              aria-current={key === section ? 'page' : undefined}
              className={`shrink-0 rounded-md px-3 py-2 text-left text-base transition-colors ${key === section ? 'bg-surface-raised text-text' : 'text-text-secondary hover:bg-bg-secondary'}`}
              disabled={settings.saving || starting}
              onClick={() => void select(key)}
            >
              {title}
            </TooltipButton>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-4">
          {(error || settings.error) && (
            <p role="alert" className="text-danger text-base">
              {error ?? settings.error}
            </p>
          )}
          {!settings.supported ? (
            <p className="text-text-secondary text-base">
              Machine configuration is available in Phosphor Desktop. Open this Host’s Settings
              there.
            </p>
          ) : !connection || connection.state !== 'ready' ? (
            <div className="border-border space-y-3 rounded-lg border p-4">
              <h2 className="text-xl font-semibold">Connect to {machine.label} first</h2>
              <p className="text-text-secondary text-base">
                Settings cannot be loaded or changed while this Host is unavailable. Nothing is
                queued for later, and this computer’s settings are never substituted.
              </p>
              <Button
                size="sm"
                disabled={accessBusy}
                onClick={() =>
                  void window.phosphor
                    .invoke('hosts:reconnect', machine.id)
                    .catch((e) => setError(errorText(e)))
                }
              >
                Reconnect
              </Button>
            </div>
          ) : !connection.configurationSupported ? (
            <div className="border-border space-y-3 rounded-lg border p-4">
              <h2 className="text-xl font-semibold">Update the Host to use machine settings</h2>
              <p className="text-text-secondary text-base">
                This version of {machine.label} does not offer the machine settings API. Run this on
                the Host, then reconnect:
              </p>
              <CopyCommand command="phosphor update" />
            </div>
          ) : !allowed ? (
            <div className="border-border space-y-3 rounded-lg border p-4">
              <h2 className="text-xl font-semibold">Configuration access is not enabled</h2>
              <p className="text-text-secondary text-base">
                Viewing lanes and controlling a session do not automatically permit machine-wide
                configuration. Explicitly enable settings access for this client.
              </p>
              <Button disabled={accessBusy} onClick={() => void access()}>
                {accessBusy ? 'Enabling access…' : 'Enable configuration access'}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                {scoped ? (
                  <label className="text-text-secondary flex items-center gap-2 text-sm">
                    Configuration scope
                    <select
                      aria-label="Host configuration scope"
                      value={repositoryId ?? ''}
                      onChange={(e) => {
                        const next = e.target.value || undefined
                        e.currentTarget.value = repositoryId ?? ''
                        void (async () => {
                          if (await confirmSettingsNavigation(machine.id)) setRepositoryId(next)
                        })()
                      }}
                      disabled={settings.saving || starting}
                      className="border-border bg-bg max-w-72 rounded-md border p-1.5"
                    >
                      <option value="">{machine.label} · machine defaults</option>
                      {connection.repositories.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                          {repo.name} · folder only
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="text-text-tertiary text-sm">Machine-wide settings</span>
                )}
                <Button
                  size="xs"
                  disabled={settings.loading || settings.saving || starting}
                  onClick={() =>
                    void (async () => {
                      if (await confirmSettingsNavigation(machine.id)) await settings.refresh()
                    })()
                  }
                >
                  {settings.loading ? 'Reading Host settings…' : 'Refresh'}
                </Button>
              </div>
              {!terminals && (
                <p className="text-warning text-base">
                  Native Host terminal support is unavailable or not granted. Sign-in and setup
                  actions are disabled; read-only checks remain available.
                </p>
              )}
              {starting && (
                <p role="status" className="text-text-secondary flex items-center gap-2 text-base">
                  <Spinner />
                  Starting the private program on {machine.label}…
                </p>
              )}
              {settings.loading && !settings.data ? (
                <div
                  role="status"
                  aria-label="Loading machine settings"
                  className="space-y-4 rounded-lg py-4"
                >
                  <Skeleton className="h-5 w-40" />
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} className="h-12 w-full" />
                  ))}
                </div>
              ) : settings.data ? (
                <>
                  {section === 'providers' && (
                    <MachineProviderSettings
                      hostId={machine.id}
                      label={machine.label}
                      settings={settings}
                      programs={programs}
                    />
                  )}
                  {section === 'connectors' && (
                    <MachineConnectorSettings
                      label={machine.label}
                      settings={settings}
                      programs={programs}
                      repositoryId={repositoryId}
                    />
                  )}
                  {section === 'agent' && (
                    <MachineAgentSettings
                      key={repositoryId ?? 'machine'}
                      hostId={machine.id}
                      label={machine.label}
                      settings={settings}
                      repositoryId={repositoryId}
                    />
                  )}
                  {section === 'folders' && (
                    <MachineFolderSettings
                      hostId={machine.id}
                      label={machine.label}
                      programs={programs}
                    />
                  )}
                  {section === 'resources' && (
                    <MachineResourceSettings
                      hostId={machine.id}
                      label={machine.label}
                      settings={settings}
                      programs={programs}
                    />
                  )}
                  {section === 'advanced' && (
                    <MachineAdvancedSettings label={machine.label} settings={settings} />
                  )}
                </>
              ) : (
                <p className="text-text-secondary text-base">
                  No Host settings were loaded. Refresh to try again.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {program && (
        <HostProgramDialog
          hostLabel={machine.label}
          {...program}
          onClose={() => {
            setProgram(null)
            void settings.refresh()
          }}
          onSettled={() => void settings.refresh()}
        />
      )}
    </section>
  )
}
