import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { McpCacheEntry, McpConfigsResult, McpResolvedServer, McpScope } from '@shared/mcp'
import type { ConnectorCheckResult } from '@shared/connectors'
import { errorText } from '@shared/errors'
import { stripAnsi } from '@shared/ansi'
import { useActiveWorkspace } from '@/stores/workspaces'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useConnectorsStore, type ConnectFlow } from '@/stores/connectors'
import { FlowCard } from '@/features/connectors/FlowCard'
import { ServerEditor } from '@/features/connectors/ServerEditor'
import { ChevronIcon } from '@/components/icons'
import { Button, TextInput } from '@/components/form'
import {
  CONNECTORS,
  buildConnectorConfig,
  connectorForUrl,
  connectorUrl,
  type ConnectorChoice,
  type ConnectorEntry,
  type ConnectorSetup,
} from '@/features/connectors/catalog'
import {
  CHECK_DOT,
  MCP_STATUS_STATUS_KEY,
  checkResultLabel,
  connectorAction,
  connectorActionLabel,
  parseMcpStatus,
  stateLabel,
  type McpServerState,
} from '@/features/connectors/mcpStatus'
import { usePackageJob } from '../usePackageJob'
import { JobOutput } from '../JobOutput'
import { ConfigFileEditor, mcpConfigFile } from '../ConfigFileEditor'

const SCOPE_LABELS: Record<McpScope, string> = {
  xdg: '~/.config/mcp',
  agents: '~/.agents',
  'agents-dir': '~/.agents/mcp',
  'pi-global': 'pi global',
  project: 'project .mcp.json',
  'pi-project': 'project .pi',
}

const ADAPTER_PACKAGE = 'npm:pi-mcp-adapter'

/**
 * Settings → Connectors: every MCP server a session can reach, in one list.
 *
 * This was two tabs. They were two views of one list — a connector IS an MCP
 * server, and connecting one writes the `pi-global` scope of the very chain
 * the other tab resolved, so the same rows appeared twice with different
 * affordances. Worse, only the catalog view had the adapter's structured
 * per-server state, so the view that listed EVERY server was the one that
 * could not say whether any of them worked.
 *
 * The list is now the resolved chain (the truth), enriched with catalog
 * metadata where a server's URL matches a known connector. The catalog is an
 * add affordance, not a separate world. Scope resolution, raw JSON repair and
 * the adapter's install state live under Advanced, because they are repair
 * tools rather than daily controls.
 *
 * Phosphor still never holds a token: it writes mcp.json and drives the adapter's
 * own `/mcp-auth`. See docs/mcp.md.
 */
export function ConnectorsTab(): React.JSX.Element {
  const workspacePath = useActiveWorkspace()
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const [configs, setConfigs] = useState<McpConfigsResult | null>(null)
  const [cache, setCache] = useState<McpCacheEntry[]>([])
  const [packages, setPackages] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<McpResolvedServer | null>(null)
  const [rawEdit, setRawEdit] = useState<McpScope | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [checks, setChecks] = useState<Record<string, ConnectorCheck>>({})

  const flows = useConnectorsStore((s) => s.flows)
  const statusText = useExtensionUiStore((s) =>
    activeSessionId ? s.statuses[activeSessionId]?.[MCP_STATUS_STATUS_KEY] : undefined,
  )
  const status = useMemo(() => parseMcpStatus(statusText), [statusText])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextConfigs, nextCache, packageEntries] = await Promise.all([
        window.phosphor.invoke('mcp:readConfigs', workspacePath ?? undefined),
        window.phosphor.invoke('mcp:readCache'),
        // Per-scope package entries — pi loads BOTH scopes' packages, so the
        // merged settings view (where a project array shadows global) would
        // misreport the adapter as missing.
        window.phosphor.invoke('packages:list', workspacePath ?? undefined),
      ])
      setConfigs(nextConfigs)
      setCache(nextCache)
      setPackages(packageEntries.map((entry) => entry.spec))
    } catch (err) {
      setError(errorText(err))
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const installJob = usePackageJob(() => void refresh())
  const adapterInstalled = packages?.some((p) => p.includes('pi-mcp-adapter')) ?? false

  /**
   * Test one connector: the adapter reconnects it and reports what happened.
   * Needs no session, so this works from the home screen — which is where the
   * question "is this thing up?" is actually asked.
   */
  const runCheck = async (serverName: string): Promise<void> => {
    setChecks((c) => ({ ...c, [serverName]: { status: 'running' } }))
    try {
      const result = await window.phosphor.invoke(
        'mcp:checkServer',
        serverName,
        workspacePath ?? undefined,
      )
      setChecks((c) => ({ ...c, [serverName]: { status: 'done', result } }))
    } catch (err) {
      setChecks((c) => ({
        ...c,
        [serverName]: {
          status: 'done',
          result: { serverName, outcome: 'unknown', detail: errorText(err) },
        },
      }))
    }
  }

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(errorText(err))
    }
  }

  /** Catalog entries that are not already in the resolved chain. */
  const unconfigured = useMemo(() => {
    const taken = new Set<string>()
    for (const server of configs?.servers ?? []) {
      const entry = connectorForUrl(server.config.url)
      if (entry) taken.add(entry.id)
    }
    return CONNECTORS.filter((entry) => !taken.has(entry.id))
  }, [configs])

  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-semibold">MCP Connectors</h2>
      <p className="text-text-secondary mt-1 text-base">
        Services reachable over the Model Context Protocol, provided to sessions by the{' '}
        <span className="font-mono">pi-mcp-adapter</span> package. Signing in runs the
        adapter&apos;s own OAuth flow — it stores the tokens in your operating system&apos;s
        credential store, and Phosphor never holds a copy.
      </p>

      {packages !== null && !adapterInstalled && (
        <div className="border-warning/30 bg-warning/10 mt-3 rounded-lg border px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-3 text-base">
            <span className="text-text-secondary">
              The adapter package is not installed — nothing below will load.
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setError(null)
                void installJob.start(() =>
                  window.phosphor.invoke(
                    'packages:run',
                    'install',
                    ADAPTER_PACKAGE,
                    'global',
                    undefined,
                  ),
                )
              }}
              disabled={installJob.running}
              className="shrink-0"
            >
              {installJob.running ? 'Installing…' : 'Install'}
            </Button>
          </div>
          <JobOutput
            running={installJob.running}
            output={installJob.output}
            exitCode={installJob.exitCode}
          />
        </div>
      )}

      {error && (
        <div className="border-danger/30 bg-danger-soft text-danger mt-3 rounded-lg border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Configured servers — the resolved chain, which is the truth. Kept
          FIRST so its controls are what a reader reaches for by default. */}
      <div className="mt-5 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Connected</h3>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add custom server…
        </Button>
      </div>
      <div className="mt-2 space-y-1.5">
        {configs?.servers.map((server) => {
          const entry = connectorForUrl(server.config.url)
          const live = status?.servers.find((s) => s.name === server.name)
          return (
            <ConfiguredRow
              key={server.name}
              server={server}
              entry={entry}
              state={live?.state ?? null}
              toolCount={live?.toolCount ?? 0}
              cache={cache.find((c) => c.name === server.name)}
              flow={flows[server.name]}
              sessionId={activeSessionId}
              check={checks[server.name]}
              onCheck={() => void runCheck(server.name)}
              onToggle={(disabled) =>
                void act(() =>
                  window.phosphor.invoke(
                    'mcp:setDisabled',
                    server.scope,
                    workspacePath ?? undefined,
                    server.name,
                    disabled,
                  ),
                )
              }
              onKeepAlive={(keep) =>
                void act(() =>
                  window.phosphor.invoke(
                    'mcp:upsertServer',
                    server.scope === 'pi-project' ? 'pi-project' : 'pi-global',
                    workspacePath ?? undefined,
                    server.name,
                    { ...server.config, lifecycle: keep ? 'lazy-keep-alive' : 'lazy' },
                  ),
                )
              }
              onRemove={() =>
                void act(() =>
                  window.phosphor.invoke(
                    'mcp:removeServer',
                    server.scope,
                    workspacePath ?? undefined,
                    server.name,
                  ),
                )
              }
              onEdit={() => setEditing(server)}
            />
          )
        })}
        {configs && configs.servers.length === 0 && (
          <div className="text-text-tertiary py-3 text-base">No MCP servers configured yet.</div>
        )}
      </div>

      {/* The curated catalog, reduced to what it actually is: an add button
          with a vetted URL behind it. */}
      {unconfigured.length > 0 && (
        <>
          <h3 className="mt-6 text-lg font-semibold">Add a connector</h3>
          <div className="mt-2 space-y-1.5">
            {unconfigured.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                onAdd={(choice) =>
                  void act(async () => {
                    await window.phosphor.invoke(
                      'mcp:upsertServer',
                      'pi-global',
                      undefined,
                      entry.serverName,
                      buildConnectorConfig(entry, choice),
                    )
                    // Adding was never the goal; being signed in is. Add used
                    // to only write mcp.json, so the connector landed in the
                    // list above still needing a separate Sign in — which
                    // reads as "Add did nothing", most sharply on Slack,
                    // where you have just pasted a client id and expect a
                    // browser.
                    //
                    // Headless on purpose, even with a session open: a live
                    // session's adapter loaded mcp.json when it started, so
                    // it has never heard of the server just written and would
                    // refuse the command.
                    await useConnectorsStore.getState().connect(entry.serverName)
                  })
                }
              />
            ))}
          </div>
        </>
      )}

      {/* Repair tools, not daily controls. */}
      <button
        onClick={() => setAdvanced((a) => !a)}
        className="text-text-tertiary hover:text-text mt-6 flex items-center gap-1.5 text-base"
      >
        <ChevronIcon size={8} expanded={advanced} />
        Advanced
      </button>
      {advanced && (
        <div className="mt-2">
          {adapterInstalled && (
            <div className="border-border bg-bg-secondary/50 rounded-lg border px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-base">
                <span className="bg-success h-1.5 w-1.5 rounded-full" />
                <span className="text-text">pi-mcp-adapter is in pi&apos;s packages</span>
                <AdapterSessionStatus />
              </div>
            </div>
          )}

          <h4 className="mt-4 text-base font-semibold">Config files</h4>
          <p className="text-text-tertiary mt-0.5 text-sm">
            Resolution order, lowest → highest — later files override earlier ones per server name.
          </p>
          <div className="border-border mt-2 divide-y rounded-lg border">
            {configs?.files.map((file) => (
              <div key={file.scope} className="flex items-center gap-2 px-3 py-1.5 text-base">
                <span className="text-text-secondary w-32 shrink-0">
                  {SCOPE_LABELS[file.scope]}
                </span>
                <span
                  className="text-text-tertiary min-w-0 flex-1 truncate font-mono text-sm"
                  title={file.path}
                >
                  {file.path}
                </span>
                {file.malformed ? (
                  <span className="text-danger shrink-0 text-sm" title={file.error}>
                    malformed
                  </span>
                ) : file.exists ? (
                  <span className="text-text-tertiary shrink-0 text-sm">
                    {file.serverNames.length} server{file.serverNames.length === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="text-text-tertiary/60 shrink-0 text-sm">absent</span>
                )}
                <button
                  onClick={() => setRawEdit(file.scope)}
                  className="text-text-tertiary hover:text-text shrink-0 text-sm underline-offset-2 hover:underline"
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(adding || editing) && (
        <ServerEditor
          initial={editing}
          workspacePath={workspacePath ?? undefined}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSave={(scope, name, config) =>
            void act(async () => {
              await window.phosphor.invoke(
                'mcp:upsertServer',
                scope,
                workspacePath ?? undefined,
                name,
                config,
              )
              setAdding(false)
              setEditing(null)
            })
          }
        />
      )}

      {rawEdit && (
        <ConfigFileEditor
          source={mcpConfigFile(rawEdit, workspacePath ?? undefined)}
          onClose={() => {
            setRawEdit(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

/** One row's connection test: in flight, or the verdict it produced. */
type ConnectorCheck = { status: 'running' } | { status: 'done'; result: ConnectorCheckResult }

const STATE_DOT: Record<McpServerState, string> = {
  connected: 'bg-success',
  'needs-auth': 'bg-warning',
  failed: 'bg-danger',
  cached: 'bg-info',
  disabled: 'bg-border-strong',
  'not-connected': 'bg-border-strong',
}

/**
 * One resolved server. Carries the config controls the MCP tab had AND the
 * auth controls the Connectors tab had, because they always described the
 * same row.
 */
function ConfiguredRow({
  server,
  entry,
  state,
  toolCount,
  cache,
  flow,
  sessionId,
  check,
  onCheck,
  onToggle,
  onKeepAlive,
  onRemove,
  onEdit,
}: {
  server: McpResolvedServer
  entry: ConnectorEntry | undefined
  state: McpServerState | null
  toolCount: number
  cache?: McpCacheEntry
  flow?: ConnectFlow
  sessionId: string | null
  check?: ConnectorCheck
  onCheck: () => void
  onToggle: (disabled: boolean) => void
  onKeepAlive: (keep: boolean) => void
  onRemove: () => void
  onEdit: () => void
}): React.JSX.Element {
  const [showTools, setShowTools] = useState(false)
  const disabled = server.config.disabled === true
  const transport = server.config.url
    ? server.config.url
    : [server.config.command, ...(server.config.args ?? [])].join(' ')
  // Only a remote server has an OAuth flow to run; a stdio command has none.
  const signInable = Boolean(server.config.url)
  const action = connectorAction(state, Boolean(sessionId))
  const keepAlive =
    server.config.lifecycle === 'lazy-keep-alive' ||
    server.config.lifecycle === 'keep-alive' ||
    server.config.lifecycle === 'eager'
  const directTools = server.config.directTools ?? []
  const checked = check?.status === 'done' ? check : undefined

  return (
    <div
      className="border-border rounded-lg border px-3 py-2"
      data-testid={`connector-${entry?.id ?? server.name}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx('text-lg font-medium', disabled && 'text-text-tertiary line-through')}
        >
          {server.name}
        </span>
        <span
          className="bg-bg-secondary text-text-tertiary shrink-0 rounded px-1.5 py-px text-xs"
          title={`Defined in ${SCOPE_LABELS[server.scope]}`}
        >
          {SCOPE_LABELS[server.scope]}
        </span>
        {checked && (
          <span
            className="text-text-secondary flex shrink-0 items-center gap-1.5 text-sm"
            title={
              'detail' in checked.result && checked.result.detail
                ? `Last test — ${checked.result.detail}`
                : 'Result of the last test, which reconnected the server'
            }
          >
            <span className={clsx('h-1.5 w-1.5 rounded-full', CHECK_DOT[checked.result.outcome])} />
            {checkResultLabel(checked.result)}
          </span>
        )}
        {!checked && !state && !sessionId && (
          <span
            className="text-text-tertiary shrink-0 text-sm"
            title="Per-server state comes from the MCP adapter, which runs inside a session"
          >
            state unknown
          </span>
        )}
        {!checked && state && (
          <span
            className="text-text-tertiary flex shrink-0 items-center gap-1.5 text-sm"
            title={`${server.name}: ${stateLabel(state)}`}
          >
            <span className={clsx('h-1.5 w-1.5 rounded-full', STATE_DOT[state])} />
            {stateLabel(state)}
            {state === 'connected' && toolCount > 0 && ` · ${toolCount} tools`}
          </span>
        )}
        <span
          className="text-text-tertiary min-w-0 flex-1 truncate font-mono text-sm"
          title={transport}
        >
          {transport}
        </span>
        <Button
          size="sm"
          onClick={onCheck}
          disabled={check?.status === 'running'}
          title="Reconnect this server through the adapter and report what happened. No session needed, no tokens spent."
        >
          {check?.status === 'running' ? 'Testing…' : 'Test'}
        </Button>
        {signInable && (
          <Button
            size="sm"
            variant={action === 'sign-in' && state === 'needs-auth' ? 'primary' : undefined}
            title={
              action === 'connect'
                ? 'Open a connection now. Already signed in — this does not re-authorize.'
                : action === 'reconnect'
                  ? 'Drop and re-open the connection. This does not re-authorize.'
                  : undefined
            }
            onClick={() => {
              const store = useConnectorsStore.getState()
              // `connect` and `reconnect` both ride the adapter's own
              // /mcp reconnect, which needs the process holding the
              // connection. Signing in does not, and runs headless.
              if (action === 'sign-in') {
                void store.connect(server.name, sessionId ?? undefined)
              } else if (sessionId) {
                void store.reconnect(sessionId, server.name)
              }
            }}
          >
            {connectorActionLabel(action)}
          </Button>
        )}
        <label className="flex shrink-0 items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={!disabled}
            onChange={(e) => onToggle(!e.target.checked)}
          />
          enabled
        </label>
        <button
          onClick={onEdit}
          className="text-text-tertiary hover:text-text shrink-0 text-sm underline-offset-2 hover:underline"
        >
          Edit
        </button>
        <button
          onClick={() => {
            if (signInable) {
              void useConnectorsStore.getState().disconnect(server.name, sessionId ?? undefined)
            }
            onRemove()
          }}
          className="text-text-tertiary hover:text-danger shrink-0 text-sm underline-offset-2 hover:underline"
        >
          Remove
        </button>
      </div>

      {entry && <div className="text-text-tertiary mt-0.5 text-sm">{entry.summary}</div>}

      <div className="text-text-tertiary mt-1 flex flex-wrap items-center gap-2 text-sm">
        {cache && cache.tools.length > 0 && (
          <button onClick={() => setShowTools((s) => !s)} className="flex items-center gap-1">
            <ChevronIcon size={8} expanded={showTools} />
            {cache.tools.length} cached tool{cache.tools.length === 1 ? '' : 's'}
          </button>
        )}
        {server.shadows.length > 0 && (
          <span title="Lower-precedence files also define this server">
            shadows {server.shadows.map((s) => SCOPE_LABELS[s]).join(', ')}
          </span>
        )}
        {signInable && (
          <label
            className="flex items-center gap-1"
            title={
              keepAlive
                ? 'Connection stays open after the first call of the session, so the row reads Connected once a tool has been used. Until then it stays idle.'
                : 'Adapter default: connect per call, then drop. The row stays idle between uses.'
            }
          >
            <input
              type="checkbox"
              checked={keepAlive}
              onChange={(e) => onKeepAlive(e.target.checked)}
            />
            keep connected
          </label>
        )}
      </div>

      {directTools.length > 0 && (
        <div className="text-warning mt-1 text-sm">
          direct: <span className="font-mono">{directTools.slice(0, 4).join(', ')}</span>
          {directTools.length > 4 && ` +${directTools.length - 4}`} — these register as top-level
          tools instead of going through the <span className="font-mono">mcp</span> gateway, so they
          cost their full schema in every request.
        </div>
      )}

      {showTools && cache && (
        <div className="text-text-secondary mt-1 font-mono text-sm">{cache.tools.join(' · ')}</div>
      )}

      {checked && 'detail' in checked.result && checked.result.detail && (
        <div
          className={clsx(
            'mt-1 text-sm',
            checked.result.outcome === 'failed' || checked.result.outcome === 'missing'
              ? 'text-danger'
              : 'text-text-tertiary',
          )}
        >
          {checked.result.detail}
        </div>
      )}

      {flow && <FlowCard serverName={server.name} flow={flow} />}
    </div>
  )
}

/** A catalog entry that is not configured yet: vetted URL behind one button. */
function CatalogRow({
  entry,
  onAdd,
}: {
  entry: ConnectorEntry
  onAdd: (choice: ConnectorChoice) => void
}): React.JSX.Element {
  const [variant, setVariant] = useState(entry.variants?.options[0]?.id ?? '')
  const [readOnly, setReadOnly] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const url = connectorUrl(entry, { variant, readOnly })
  const needsClientId = entry.authKind === 'preregistered'

  return (
    <div
      className="border-border rounded-lg border px-3 py-2"
      data-testid={`connector-${entry.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg font-medium">{entry.name}</span>
        <span className="text-text-tertiary min-w-0 flex-1 truncate font-mono text-sm" title={url}>
          {url}
        </span>
        <Button
          variant="primary"
          size="sm"
          // Slack cannot be one click: it supports no dynamic registration and
          // requires its client id up front. Showing that as a disabled button
          // beats letting `buildConnectorConfig` throw into the error banner.
          disabled={needsClientId && !clientId.trim()}
          title={
            needsClientId && !clientId.trim()
              ? `${entry.name} has no dynamic registration — paste the client ID of an app you registered.`
              : undefined
          }
          onClick={() => onAdd({ variant, readOnly, clientId, clientSecret })}
        >
          Add
        </Button>
      </div>

      <div className="text-text-tertiary mt-0.5 text-sm">{entry.summary}</div>
      {entry.caveat && <div className="text-text-tertiary mt-1 text-sm">{entry.caveat}</div>}

      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
        {entry.variants && (
          <label className="flex items-center gap-1.5">
            {entry.variants.label}
            <select
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              className="border-border bg-bg-secondary rounded px-1.5 py-0.5"
            >
              {entry.variants.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {entry.readOnlyUrl && (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            read-only
          </label>
        )}
        {needsClientId && (
          <>
            <TextInput
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="client ID"
              className="w-40 font-mono"
            />
            <TextInput
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="client secret (optional)"
              className="w-48 font-mono"
            />
          </>
        )}
      </div>

      {entry.setup && <SetupSteps setup={entry.setup} />}
    </div>
  )
}

/**
 * The console work a `preregistered` connector needs before its client id
 * exists. Collapsed by default — it is a one-time errand, and the row above
 * it is what people came for.
 */
function SetupSteps({ setup }: { setup: ConnectorSetup }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  return (
    <div className="text-text-tertiary mt-1.5 text-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1">
        <ChevronIcon size={8} expanded={open} />
        Set up the app
      </button>

      {open && (
        <ol className="mt-1 ml-4 list-decimal space-y-1">
          {setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}

      {open && setup.snippet && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <span>{setup.snippet.label}</span>
            <button
              className="underline-offset-2 hover:underline"
              onClick={() => {
                void navigator.clipboard.writeText(setup.snippet?.text ?? '')
                setCopied(true)
              }}
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <pre className="border-border bg-bg-secondary mt-1 max-h-48 overflow-auto rounded border p-2 font-mono text-sm">
            {setup.snippet.text}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Live-ish status: the adapter's setStatus line for the active session. */
function AdapterSessionStatus(): React.JSX.Element | null {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const statuses = useExtensionUiStore((s) =>
    activeSessionId ? s.statuses[activeSessionId] : undefined,
  )
  const mcpStatus = useMemo(() => {
    for (const [key, text] of Object.entries(statuses ?? {})) {
      if (key.toLowerCase().includes('mcp') || stripAnsi(text).toLowerCase().includes('mcp')) {
        return stripAnsi(text)
      }
    }
    return null
  }, [statuses])

  if (!mcpStatus) return null
  return (
    <span className="text-text-tertiary text-sm" title="Reported by pi-mcp-adapter">
      · {mcpStatus}
    </span>
  )
}
