import { useState } from 'react'
import type { McpServerConfig } from '@shared/mcp'
import { MCP_SERVER_NAME } from '@shared/mcp'
import { Button, TextInput } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { CopyButton } from '@/components/CopyButton'
import {
  CONNECTORS,
  buildConnectorConfig,
  type ConnectorChoice,
} from '@/features/connectors/catalog'
import { promptChoice } from '@/stores/prompt'
import { Card, StatusPill } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'
import type { MachinePrograms } from './MachineProviderSettings'

export function MachineConnectorSettings({
  label,
  settings,
  programs,
  repositoryId,
}: {
  label: string
  settings: HostSettingsState
  programs: MachinePrograms
  repositoryId?: string
}): React.JSX.Element | null {
  const [adding, setAdding] = useState(false)
  const state = settings.data?.connectors
  if (!state) return null
  const busy = settings.loading || settings.saving || programs.busy
  return (
    <div className="space-y-4">
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
      <Card
        title="Configured on this Host"
        aside={
          state.checkedAt
            ? `Checked ${new Date(state.checkedAt).toLocaleTimeString()}`
            : 'Status not checked yet'
        }
      >
        {!state.servers.length ? (
          <p className="text-text-secondary text-base">
            No connectors in this scope yet. Add one and sign in on {label}.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {state.servers.map((server) => (
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
                <div className="flex flex-wrap gap-2">
                  {server.transport === 'https' && (
                    <>
                      <Button
                        size="xs"
                        disabled={busy || !programs.available || !server.enabled}
                        onClick={() =>
                          programs.task({ task: 'mcp.login', name: server.name, repositoryId })
                        }
                      >
                        Sign in
                      </Button>
                      <Button
                        size="xs"
                        disabled={busy || !programs.available}
                        onClick={() =>
                          programs.task({ task: 'mcp.logout', name: server.name, repositoryId })
                        }
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
                            choices: [
                              { value: 'remove', label: 'Remove connector', primary: true },
                            ],
                          })) === 'remove'
                        )
                          await settings.change({ type: 'mcp.remove', name: server.name })
                      })()
                    }
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-text-tertiary text-sm">
        New lanes read the saved configuration. Existing lanes keep their current tools until
        explicitly reloaded. Sign-in is only marked connected after a status check, not just because
        a browser opened.
      </p>
      {adding && (
        <AddHostConnector
          key={repositoryId ?? 'machine'}
          label={label}
          busy={busy}
          onClose={() => setAdding(false)}
          onSave={async (name, config) => {
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
          }}
        />
      )}
    </div>
  )
}
function AddHostConnector({
  label,
  busy,
  onClose,
  onSave,
}: {
  label: string
  busy: boolean
  onClose(): void
  onSave(name: string, config: McpServerConfig): Promise<void>
}): React.JSX.Element {
  const [entryId, setEntryId] = useState(CONNECTORS[0]?.id ?? 'custom')
  const [choice, setChoice] = useState<ConnectorChoice>({ readOnly: true })
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'https' | 'stdio'>('https')
  const [endpoint, setEndpoint] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const entry = CONNECTORS.find((e) => e.id === entryId)
  const save = async () => {
    setError(null)
    try {
      const serverName = entry?.serverName ?? name.trim()
      if (!serverName || serverName.length > 64 || !MCP_SERVER_NAME.test(serverName))
        throw new Error('Use a server name with letters, numbers, underscores or hyphens.')
      let config: McpServerConfig
      if (entry) config = buildConnectorConfig(entry, choice)
      else if (kind === 'https') {
        const url = new URL(endpoint.trim())
        if (
          url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        )
          throw new Error('Use HTTPS, or an HTTP loopback server running on the Host.')
        if (url.username || url.password)
          throw new Error(
            'Do not embed credentials in the URL. Use the one-time Authorization field.',
          )
        config = {
          url: url.href,
          ...(secret.trim() ? { headers: { Authorization: secret.trim() } } : {}),
        }
      } else {
        if (!command.trim() || /[\n\r\0]/.test(command))
          throw new Error(
            'Enter one command name or Host executable path. Arguments go below, one per line.',
          )
        config = { command: command.trim(), args: args.split('\n').filter(Boolean) }
      }
      await onSave(serverName, config)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add connector.')
    }
  }
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={`Add connector on ${label}`}>
        <ModalPanel
          width={620}
          title={`Add connector on ${label}`}
          footer={
            <>
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Review and add'}
              </Button>
            </>
          }
        >
          <div className="max-h-[65vh] space-y-4 overflow-y-auto p-5 text-base">
            <label className="block">
              Connector
              <select
                aria-label="Connector catalogue"
                className="border-border bg-bg mt-1 w-full rounded-md border p-2"
                value={entryId}
                onChange={(e) => {
                  setEntryId(e.target.value)
                  setChoice({ readOnly: true })
                  setSecret('')
                }}
              >
                {CONNECTORS.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
                <option value="custom">Custom server</option>
              </select>
            </label>
            {entry ? (
              <>
                <p className="text-text-secondary">{entry.summary}</p>
                {entry.caveat && <p className="text-warning">{entry.caveat}</p>}
                {entry.variants && (
                  <label className="block">
                    {entry.variants.label}
                    <select
                      aria-label="Connector variant"
                      className="border-border bg-bg mt-1 w-full rounded-md border p-2"
                      value={choice.variant ?? entry.variants.options[0]?.id}
                      onChange={(e) => setChoice({ ...choice, variant: e.target.value })}
                    >
                      {entry.variants.options.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {entry.readOnlyUrl && (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={choice.readOnly !== false}
                      onChange={(e) => setChoice({ ...choice, readOnly: e.target.checked })}
                    />
                    Use the read-only endpoint
                  </label>
                )}
                {entry.setup && (
                  <div className="space-y-2">
                    <ol className="text-text-secondary list-inside list-decimal space-y-1">
                      {entry.setup.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    {entry.setup.snippet && (
                      <div>
                        <CopyButton
                          text={entry.setup.snippet.text}
                          title={`Copy ${entry.setup.snippet.label}`}
                        />
                        <pre className="border-border mt-2 max-h-40 overflow-auto rounded-md border p-2 font-mono text-sm">
                          {entry.setup.snippet.text}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
                {entry.authKind === 'preregistered' && (
                  <>
                    <label className="block">
                      Client ID
                      <TextInput
                        aria-label="Client ID"
                        value={choice.clientId ?? ''}
                        onChange={(e) => setChoice({ ...choice, clientId: e.target.value })}
                        className="mt-1 w-full"
                      />
                    </label>
                    <label className="block">
                      Client secret {entry.secretRequired ? '(required)' : '(optional)'}
                      <TextInput
                        type="password"
                        autoComplete="off"
                        aria-label="Client secret"
                        value={choice.clientSecret ?? ''}
                        onChange={(e) => setChoice({ ...choice, clientSecret: e.target.value })}
                        className="mt-1 w-full"
                      />
                    </label>
                  </>
                )}
              </>
            ) : (
              <>
                <label className="block">
                  Server name
                  <TextInput
                    aria-label="Server name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 w-full"
                  />
                </label>
                <label className="block">
                  Transport
                  <select
                    aria-label="Connector transport"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    className="border-border bg-bg mt-1 w-full rounded-md border p-2"
                  >
                    <option value="https">HTTPS server</option>
                    <option value="stdio">Command running on {label}</option>
                  </select>
                </label>
                {kind === 'https' ? (
                  <>
                    <label className="block">
                      URL on the Host network
                      <TextInput
                        aria-label="Server URL"
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                        className="mt-1 w-full"
                        placeholder="https://example.com/mcp"
                      />
                    </label>
                    <label className="block">
                      Authorization header (optional, never read back)
                      <TextInput
                        type="password"
                        autoComplete="off"
                        aria-label="Authorization header"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        className="mt-1 w-full"
                        placeholder="Bearer …"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="block">
                      Command
                      <TextInput
                        aria-label="Host command"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        className="mt-1 w-full"
                        placeholder="npx"
                      />
                    </label>
                    <label className="block">
                      Arguments, one per line
                      <textarea
                        aria-label="Host command arguments"
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        className="border-border bg-bg mt-1 min-h-24 w-full rounded-md border p-2 font-mono"
                        placeholder={'-y\n@vendor/mcp-server'}
                      />
                    </label>
                    <p className="text-warning">
                      This command runs as the Host user, not inside a sandbox. You must explicitly
                      trust it.
                    </p>
                  </>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <p className="text-text-tertiary text-sm">
              Nothing is copied to another machine. This form does not display stored credentials or
              write to the control plane.
            </p>
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
