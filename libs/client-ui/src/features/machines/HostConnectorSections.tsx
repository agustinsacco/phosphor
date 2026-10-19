import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import type { MachineSettings } from '@shared/machine-settings'
import type { McpServerConfig } from '@shared/mcp'
import type { Dispatch, SetStateAction } from 'react'
import type { MachinePrograms } from './MachineProviderSettings'
import { StatusPill } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'
type ConnectorState = NonNullable<MachineSettings['connectors']>
interface ConnectorProps {
  label: string
  settings: HostSettingsState
  programs: MachinePrograms
  repositoryId?: string
  state: ConnectorState
  busy: boolean
  server: ConnectorState['servers'][number]
}
export function HostConnectorRow(props: ConnectorProps): React.JSX.Element {
  const { server, label, repositoryId } = props
  return (
    <li key={server.name} className="space-y-2 py-3" data-connector={server.name}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-medium">{server.name}</h3>
          <p className="text-text-secondary text-sm">
            {server.transport === 'stdio' ? `Command runs on ${label}` : 'HTTPS'} ·{' '}
            {server.scope === 'global'
              ? repositoryId
                ? 'inherited from machine'
                : 'machine defaults'
              : 'folder override'}{' '}
            · {server.exposure}
            {server.tools !== undefined ? ` · ${server.tools} tools` : ''}
          </p>
        </div>
        <StatusPill
          tone={
            !server.enabled
              ? 'off'
              : server.state === 'connected'
                ? 'ok'
                : server.state === 'failed' || server.state === 'needs-auth'
                  ? 'warn'
                  : 'off'
          }
        >
          {!server.enabled
            ? 'Disabled'
            : server.state === 'connected'
              ? 'Connected'
              : server.state === 'needs-auth'
                ? 'Needs sign-in'
                : server.state === 'failed'
                  ? 'Connection failed'
                  : 'Not verified'}
        </StatusPill>
      </div>
      <HostConnectorActions {...props} />
    </li>
  )
}
function HostConnectorActions(props: ConnectorProps): React.JSX.Element {
  const { server, programs, repositoryId, settings, busy, state } = props
  return (
    <div className="flex flex-wrap gap-2">
      {server.transport === 'https' && (
        <>
          <Button
            size="xs"
            disabled={busy || !programs.available || !server.enabled}
            onClick={() => programs.task({ task: 'mcp.login', name: server.name, repositoryId })}
          >
            Sign in
          </Button>
          <Button
            size="xs"
            disabled={busy || !programs.available}
            onClick={() => programs.task({ task: 'mcp.logout', name: server.name, repositoryId })}
          >
            Sign out
          </Button>
        </>
      )}
      <Button
        size="xs"
        disabled={busy || state.legacy || state.malformed}
        onClick={() =>
          void settings.change({
            type: 'mcp.enabled',
            name: server.name,
            enabled: !server.enabled,
          })
        }
      >
        {server.enabled ? 'Disable' : 'Enable'}
        {repositoryId && server.scope === 'global' ? ' in this folder' : ''}
      </Button>
      <RemoveHostConnector {...props} />
    </div>
  )
}

export function RemoveHostConnector({
  server,
  label,
  repositoryId,
  settings,
  busy,
}: ConnectorProps): React.JSX.Element {
  return (
    <Button
      size="xs"
      disabled={busy || (!!repositoryId && server.scope === 'global')}
      tooltip={
        repositoryId && server.scope === 'global'
          ? 'Switch to machine scope to remove an inherited entry'
          : 'Remove configuration from this Host'
      }
      onClick={() =>
        void (async () => {
          if (
            (await promptChoice({
              title: `Remove ${server.name} on ${label}?`,
              message:
                'New lanes will no longer load it in this scope. Existing lanes are not automatically restarted. This does not sign the connector out on another machine.',
              choices: [{ value: 'remove', label: 'Remove connector', primary: true }],
            })) === 'remove'
          )
            await settings.change({ type: 'mcp.remove', name: server.name })
        })()
      }
    >
      Remove
    </Button>
  )
}

export function HostConnectorHeading({
  label,
  settings,
  state,
  busy,
  setAdding,
}: Pick<ConnectorProps, 'label' | 'settings' | 'state' | 'busy'> & {
  setAdding: Dispatch<SetStateAction<boolean>>
}): React.JSX.Element {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Connectors</h2>
          <p className="text-text-secondary mt-1 text-base">
            MCP tools for agents on {label}. Nothing is imported from this computer.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void (async () => {
                if (
                  (await promptChoice({
                    title: `Check connectors on ${label}?`,
                    message:
                      'pi will connect to the configured servers, including starting stdio commands as the Host user. Only continue if you trust this Host’s MCP configuration. Results are not copied to another machine.',
                    choices: [{ value: 'check', label: 'Check on this Host', primary: true }],
                  })) === 'check'
                )
                  await settings.check()
              })()
            }
          >
            {settings.loading ? 'Checking…' : 'Check status'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || state.legacy || state.malformed}
            onClick={() => setAdding(true)}
          >
            Add connector
          </Button>
        </div>
      </div>
      {state.legacy && (
        <p role="alert" className="text-warning text-base">
          This Host still has pi-mcp-adapter configuration. Migrate it on {label} before editing
          built-in MCP connectors. Nothing has been rewritten.
        </p>
      )}
      {state.malformed && (
        <p role="alert" className="text-warning text-base">
          The Host’s MCP configuration has errors. Fix it on {label}; this page will not overwrite
          malformed settings.
        </p>
      )}
      {state.trusted === false && (
        <p className="text-warning text-base">
          This folder is not trusted by pi on {label}. Its MCP overrides are not active. Review and
          trust it under Folders before using them.
          {!!state.inactiveNames?.length && (
            <span className="mt-1 block">
              Saved but inactive folder entries include: {state.inactiveNames.join(', ')}.
            </span>
          )}
        </p>
      )}
    </>
  )
}
export async function saveHostConnector(
  {
    settings,
    label,
    repositoryId,
    setAdding,
  }: Pick<ConnectorProps, 'settings' | 'label' | 'repositoryId'> & {
    setAdding: Dispatch<SetStateAction<boolean>>
  },
  name: string,
  config: McpServerConfig,
): Promise<void> {
  if (repositoryId && (config.headers || config.env || config.oauth?.clientSecret))
    throw new Error(
      'Add secret-bearing connectors at machine scope, outside the repository. Then use a folder override to enable or disable them here.',
    )
  const code = typeof config.command === 'string'
  const approved = await promptChoice({
    title: `Add ${name} on ${label}?`,
    message: `${repositoryId ? 'Folder-specific configuration' : 'Machine-wide configuration'}. ${code ? `This starts code as the Host user: ${config.command} ${(config.args ?? []).join(' ')}. Only approve a source you trust.` : 'Credentials are stored only on this Host. Review the provider’s requested scopes during sign-in.'} Existing lanes will not restart.`,
    choices: [
      {
        value: 'save',
        label: code ? 'I trust this code: add server' : 'Save on this Host',
        primary: true,
      },
    ],
  })
  if (approved !== 'save') return
  if (
    await settings.change({
      type: 'mcp.upsert',
      name,
      config,
      ...(code ? { approveCode: true } : {}),
    })
  )
    setAdding(false)
  else
    throw new Error(
      'The Host did not confirm this save. Close this form and refresh its current configuration before trying again; the change may already have applied.',
    )
}
