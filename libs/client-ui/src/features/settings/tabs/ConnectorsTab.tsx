import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type McpResolvedServer, type McpScope } from '@shared/mcp'
import { errorText } from '@shared/errors'
import { useSettingsWorkspace } from '../SettingsMachineScope'
import { useConnectorsStore } from '@/stores/connectors'
import { ConfiguredRow, usesOAuth } from '@/features/connectors/ConfiguredRow'
import { CatalogRow } from '@/features/connectors/CatalogRow'
import { useConnectorChecks } from '@/features/connectors/useConnectorChecks'
import { useConnectorConfigs } from '@/features/connectors/useConnectorConfigs'
import { MigrationCard, adapterPackages } from '@/features/connectors/MigrationCard'
import { ServerEditor } from '@/features/connectors/ServerEditor'
import { ChevronIcon } from '@/components/icons'
import { Button } from '@/components/form'
import { CONNECTORS, buildConnectorConfig, connectorForUrl } from '@/features/connectors/catalog'
import { ConfigFileEditor, mcpConfigFile } from '../ConfigFileEditor'

const SCOPE_LABELS: Record<McpScope, string> = {
  global: 'global',
  project: 'project',
}

const NO_SERVERS: McpResolvedServer[] = []

/**
 * Settings → Connectors: every MCP server a session can reach, in one list.
 *
 * The list is pi's own resolution of its two mcp.json files, enriched with
 * catalog metadata where a server's URL matches a known connector, and with
 * native single-server inspection reports. The catalog is an add affordance, not a
 * separate world. The files themselves live under Advanced, because they are
 * repair tools rather than daily controls.
 *
 * Phosphor never holds a token: it writes mcp.json and runs pi's own
 * `pi mcp login` / `logout`. See docs/mcp.md.
 */
export function ConnectorsTab(): React.JSX.Element {
  const workspacePath = useSettingsWorkspace() ?? undefined
  const { configs, packages, error, setError, refresh } = useConnectorConfigs(workspacePath)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<McpResolvedServer | null>(null)
  const [rawEdit, setRawEdit] = useState<McpScope | null>(null)
  const [advanced, setAdvanced] = useState(false)

  const flows = useConnectorsStore((s) => s.flows)

  const adapters = useMemo(() => adapterPackages(packages ?? []), [packages])
  const legacy = Boolean(configs?.legacy) || adapters.length > 0

  const checks = useConnectorChecks(
    workspacePath,
    configs?.servers ?? NO_SERVERS,
    configs !== null && packages !== null && !legacy,
  )
  const check = checks.refresh

  // A sign-in that finishes while the tab is open changes what pi can reach;
  // ask again. One that finished before it opened is already in the first check.
  const signedIn = Object.values(flows).filter((flow) => flow.phase === 'connected').length
  const seenSignIns = useRef(signedIn)
  useEffect(() => {
    if (signedIn > seenSignIns.current) check()
    seenSignIns.current = signedIn
  }, [signedIn, check])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(errorText(err))
    }
  }

  /** Catalog entries that are not already configured. */
  const unconfigured = useMemo(() => {
    const taken = new Set<string>()
    for (const server of configs?.servers ?? []) {
      const entry = connectorForUrl(server.config.url)
      if (entry) taken.add(entry.id)
    }
    return CONNECTORS.filter((entry) => !taken.has(entry.id))
  }, [configs])

  const projectFile = configs?.files.find((file) => file.scope === 'project')
  const untrusted =
    configs?.projectTrust && !configs.projectTrust.trusted && projectFile?.exists
      ? configs.projectTrust
      : null
  const problems = configs?.errors ?? []

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">MCP Connectors</h2>
      <p className="text-text-secondary mt-1 text-base">
        Services reachable over the Model Context Protocol, connected by pi’s built-in MCP support.
        Signing in runs pi’s own OAuth flow — pi stores the tokens, and Phosphor never holds a copy.
      </p>

      {legacy && packages !== null && (
        <MigrationCard
          workspacePath={workspacePath}
          adapters={adapters}
          onDone={() => void refresh()}
        />
      )}

      {error && (
        <div className="border-danger/30 bg-danger-soft text-danger mt-3 rounded-lg border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {!legacy && (
        <>
          {[...new Set(problems)].map((problem) => (
            <div
              key={problem}
              role="alert"
              className="border-warning/30 bg-warning/10 mt-3 rounded-lg border px-3.5 py-2.5 text-sm break-words"
            >
              {problem}
            </div>
          ))}

          {untrusted && (
            <div
              role="alert"
              className="border-warning/30 bg-warning/10 mt-3 rounded-lg border px-3.5 py-2.5 text-sm"
            >
              pi ignores this project’s <span className="font-mono">.pi/mcp.json</span> until you
              trust the folder ({untrusted.path}). Run <span className="font-mono">pi</span> once in
              a terminal there and choose Trust.
            </div>
          )}

          {/* Configured servers, as pi resolves them. Kept FIRST so their
              controls are what a reader reaches for by default. */}
          <div className="bg-surface sticky top-0 z-10 mt-5 flex flex-wrap items-center justify-between gap-2 py-2">
            <h3 className="text-lg font-semibold">Connected</h3>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                onClick={() => void refresh().then(check)}
                disabled={checks.checking}
                tooltip={{
                  label: 'Reload configuration and test connections',
                  description: 'No session, no tokens spent',
                }}
              >
                {checks.checking ? 'Checking…' : 'Refresh & test all'}
              </Button>
              {checks.checking && (
                <Button size="sm" onClick={checks.cancel}>
                  Cancel checks
                </Button>
              )}
              <Button size="sm" onClick={() => setAdding(true)}>
                Add custom server…
              </Button>
            </div>
            {checks.slow && (
              <p role="status" className="text-text-secondary w-full text-sm">
                Still checking. pi may test every connector in one pass, so one slow connector can
                hold up the others. Results stay saved if you leave.
              </p>
            )}
          </div>
          <div className="mt-2 space-y-2">
            {configs?.servers.map((server) => (
              <ConfiguredRow
                key={server.name}
                server={server}
                entry={connectorForUrl(server.config.url)}
                check={checks.checks[server.name]}
                workspacePath={workspacePath}
                onTest={() => void checks.test(server.name)}
                onRefresh={() => refresh().then(check)}
                flow={flows[server.name]}
                onSignIn={() =>
                  void useConnectorsStore.getState().connect(server.name, workspacePath)
                }
                onToggle={(enabled) =>
                  void act(() =>
                    window.phosphor.invoke(
                      'mcp:setEnabled',
                      // An override decides enabled for this project, so it is changed there.
                      server.overridden ? 'project' : server.scope,
                      workspacePath,
                      server.name,
                      enabled,
                    ),
                  )
                }
                onRemove={() =>
                  void act(async () => {
                    // Credentials first: pi finds them through the config entry.
                    if (usesOAuth(server)) {
                      await window.phosphor.invoke('mcp:logout', server.name, workspacePath)
                    }
                    await window.phosphor.invoke(
                      'mcp:removeServer',
                      server.scope,
                      workspacePath,
                      server.name,
                    )
                  })
                }
                onEdit={() => setEditing(server)}
              />
            ))}
            {configs && configs.servers.length === 0 && (
              <div className="text-text-tertiary py-3 text-base">
                No MCP servers configured yet.
              </div>
            )}
          </div>

          {/* The curated catalog, reduced to what it actually is: an add button
              with a vetted URL behind it. */}
          {unconfigured.length > 0 && (
            <>
              <h3 className="mt-6 text-lg font-semibold">Add a connector</h3>
              <div className="mt-2 space-y-2">
                {unconfigured.map((entry) => (
                  <CatalogRow
                    key={entry.id}
                    entry={entry}
                    onAdd={(choice) =>
                      void act(async () => {
                        await window.phosphor.invoke(
                          'mcp:upsertServer',
                          'global',
                          undefined,
                          entry.serverName,
                          buildConnectorConfig(entry, choice),
                        )
                        // Adding was never the goal; being signed in is. Add
                        // starts the sign-in itself, so it does not read as
                        // "Add did nothing" — most sharply on Slack, where you
                        // have just pasted a client id and expect a browser.
                        await useConnectorsStore.getState().connect(entry.serverName, workspacePath)
                      })
                    }
                  />
                ))}
              </div>
            </>
          )}

          {/* Repair tools, not daily controls. */}
          <TooltipButton
            onClick={() => setAdvanced((a) => !a)}
            className="text-text-tertiary hover:text-text mt-6 flex items-center gap-1.5 text-base"
          >
            <ChevronIcon size={8} expanded={advanced} />
            Advanced
          </TooltipButton>
          {advanced && (
            <div className="mt-2">
              <h4 className="text-base font-semibold">Config files</h4>
              <p className="text-text-tertiary mt-0.5 text-sm">
                A project entry replaces the global one with the same name; one with no command or
                url only turns it on or off, or changes its exposure.
              </p>
              <div className="border-border mt-2 divide-y rounded-lg border">
                {configs?.files.map((file) => (
                  <div key={file.scope} className="flex items-center gap-2 px-3 py-1.5 text-base">
                    <span className="text-text-secondary w-20 shrink-0">
                      {SCOPE_LABELS[file.scope]}
                    </span>
                    <span
                      className="text-text-tertiary min-w-0 flex-1 truncate font-mono text-sm"
                      data-tooltip={file.path}
                    >
                      {file.path}
                    </span>
                    {file.malformed ? (
                      <span className="text-danger shrink-0 text-sm" data-tooltip={file.error}>
                        malformed
                      </span>
                    ) : file.exists ? (
                      <span className="text-text-tertiary shrink-0 text-sm">
                        {file.serverNames.length} server{file.serverNames.length === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-text-tertiary/60 shrink-0 text-sm">absent</span>
                    )}
                    <TooltipButton
                      onClick={() => setRawEdit(file.scope)}
                      className="text-text-tertiary hover:text-text shrink-0 text-sm underline-offset-2 hover:underline"
                    >
                      Edit
                    </TooltipButton>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {(adding || editing) && (
        <ServerEditor
          initial={editing}
          workspacePath={workspacePath}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSave={(scope, name, config) =>
            void act(async () => {
              await window.phosphor.invoke('mcp:upsertServer', scope, workspacePath, name, config)
              setAdding(false)
              setEditing(null)
            })
          }
        />
      )}

      {rawEdit && (
        <ConfigFileEditor
          source={mcpConfigFile(rawEdit, workspacePath)}
          onClose={() => {
            setRawEdit(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
