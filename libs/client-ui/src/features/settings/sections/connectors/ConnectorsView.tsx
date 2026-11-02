import { useMemo, useState } from 'react'
import type { McpServerConfig } from '@shared/mcp'
import { Button, SettingsNotice } from '@/components/form'
import { CONNECTORS } from '@/features/connectors/catalog'
import { MigrationCard } from '@/features/connectors/MigrationCard'
import { promptChoice } from '@/stores/prompt'
import { CatalogRow } from './CatalogRow'
import { ConfigFiles } from './ConfigFiles'
import { ConfiguredRow } from './ConfiguredRow'
import { scopeHoldsSecrets } from './serverForm'
import { ServerEditor } from './ServerEditor'
import type { ConnectorView, ConnectorsSource } from './source'

/**
 * Settings → MCP Connectors on every machine: the servers pi resolves for the
 * chosen scope, the catalogue of what is not configured yet, and the custom
 * server editor. Writes go to the scope's own file: the machine's mcp.json, or
 * the chosen folder's `.pi/mcp.json`, where a machine connector can only be
 * switched on or off. See docs/mcp.md.
 */
export function ConnectorsView({ source }: { source: ConnectorsSource }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ name: string; defined: McpServerConfig } | null>(null)
  const scope = source.folder ? 'project' : 'global'
  const servers = source.servers
  const locked = source.locked || source.busy

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">MCP Connectors</h2>
      <p className="text-text-secondary mt-1 text-base">
        Services reachable over the Model Context Protocol, connected by pi’s built-in MCP support.
        Signing in runs pi’s own OAuth flow — pi stores the tokens, and Phosphor never holds a copy.
      </p>

      {source.error && (
        <div className="mt-3">
          <SettingsNotice tone="danger" title={source.error} />
        </div>
      )}

      {source.migration ? (
        <MigrationCard
          workspacePath={source.migration.workspacePath}
          adapters={source.migration.adapters}
          onDone={() => void source.refresh()}
        />
      ) : (
        <>
          {source.notices.map((notice) => (
            <div key={notice.title} className="mt-3">
              <SettingsNotice {...notice} />
            </div>
          ))}

          {/* Configured servers first: their controls are what a reader reaches for. */}
          <ConnectorsToolbar source={source} locked={locked} onAdd={() => setAdding(true)} />
          <ConnectorList source={source} onEdit={setEditing} />

          {(adding || editing) && (
            <ServerEditor
              key={editing?.name ?? 'new'}
              initial={editing}
              scope={scope}
              reviewed={source.caps.reviewed}
              busy={locked}
              onClose={() => {
                setAdding(false)
                setEditing(null)
              }}
              onSave={(name, config) => source.run({ type: 'upsert', name, config })}
            />
          )}

          {/* The curated catalogue: an add button with a vetted URL behind it. */}
          {servers && <Catalogue source={source} servers={servers} locked={locked} />}

          {source.caps.rawFiles && source.files && (
            <ConfigFiles files={source.files} onClosed={() => void source.refresh()} />
          )}
          {source.caps.reviewed && (
            <p className="text-text-tertiary mt-6 text-sm">
              New lanes read the saved configuration; running lanes keep their tools until they
              reload. Checks and command connectors start code as the machine’s service user, so you
              confirm each first.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function ConnectorsToolbar({
  source,
  locked,
  onAdd,
}: {
  source: ConnectorsSource
  locked: boolean
  onAdd: () => void
}): React.JSX.Element {
  return (
    <div className="bg-surface sticky top-0 z-10 mt-5 flex flex-wrap items-center justify-between gap-2 py-2">
      <h3 className="text-lg font-semibold">Connected</h3>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={() => void source.run({ type: 'checkAll' })}
          disabled={source.checking || source.busy}
          tooltip={{
            label: 'Reload configuration and test connections',
            description: source.caps.reviewed
              ? 'Starts configured commands; you confirm first'
              : 'No session, no tokens spent',
          }}
        >
          {source.checking ? 'Checking…' : 'Refresh & test all'}
        </Button>
        {source.checking && source.caps.inspect && (
          <Button size="sm" onClick={() => void source.run({ type: 'cancelChecks' })}>
            Cancel checks
          </Button>
        )}
        <Button size="sm" disabled={locked} onClick={onAdd}>
          Add custom server…
        </Button>
      </div>
      {source.slow && (
        <p role="status" className="text-text-secondary w-full text-sm">
          Still checking. pi may test every connector in one pass, so one slow connector can hold up
          the others. Results stay saved if you leave.
        </p>
      )}
      {source.checkedAt !== undefined && (
        <p className="text-text-tertiary w-full text-sm">
          Checked {new Date(source.checkedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  )
}

/** Catalogue entries not configured yet, by endpoint where known, else by name. */
function Catalogue({
  source,
  servers,
  locked,
}: {
  source: ConnectorsSource
  servers: ConnectorView[]
  locked: boolean
}): React.JSX.Element | null {
  const unconfigured = useMemo(() => {
    const names = new Set(servers.map((server) => server.name))
    const ids = new Set(servers.map((server) => server.entry?.id))
    return CONNECTORS.filter((entry) => !ids.has(entry.id) && !names.has(entry.serverName))
  }, [servers])
  if (unconfigured.length === 0) return null
  const secrets = scopeHoldsSecrets(source.folder ? 'project' : 'global')
  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">Add a connector</h3>
      <div className="mt-2 space-y-2">
        {unconfigured.map((entry) => (
          <CatalogRow
            key={entry.id}
            entry={entry}
            secrets={secrets}
            disabled={locked}
            onAdd={(choice) => void source.run({ type: 'catalogue', entry, choice })}
          />
        ))}
      </div>
    </>
  )
}

/** Removing asks first; an OAuth connector is signed out before it goes. */
async function confirmRemove(source: ConnectorsSource, connector: ConnectorView): Promise<void> {
  const answer = await promptChoice({
    title: `Remove ${connector.name}?`,
    message: `${connector.oauth ? 'pi signs it out first, then it' : 'It'} leaves this scope’s configuration. New lanes stop loading it; running lanes keep it until they reload.`,
    choices: [
      {
        value: 'remove',
        label: connector.oauth ? 'Sign out and remove' : 'Remove connector',
        primary: true,
      },
    ],
  })
  if (answer === 'remove') await source.run({ type: 'remove', name: connector.name })
}

function ConnectorList({
  source,
  onEdit,
}: {
  source: ConnectorsSource
  onEdit: (editing: { name: string; defined: McpServerConfig }) => void
}): React.JSX.Element {
  return (
    <div className="mt-2 space-y-2">
      {source.servers?.map((connector) => (
        <ConfiguredRow
          key={connector.name}
          connector={connector}
          source={source}
          onEdit={() =>
            connector.inspection &&
            onEdit({ name: connector.name, defined: connector.inspection.server.defined })
          }
          onRemove={() => void confirmRemove(source, connector)}
        />
      ))}
      {source.servers?.length === 0 && (
        <div className="text-text-tertiary py-3 text-base">
          No MCP servers configured in this scope yet.
        </div>
      )}
    </div>
  )
}
