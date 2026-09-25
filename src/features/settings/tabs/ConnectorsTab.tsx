import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type {
  McpCacheEntry,
  McpCachedTool,
  McpConfigsResult,
  McpResolvedServer,
  McpScope,
} from '@shared/mcp'
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

  // Test, Reload, a finished sign-in and a session's own lazy connects all
  // rewrite the adapter's cache; main watches it so the tool lists follow.
  useEffect(() => window.phosphor.onMcpCacheChanged(() => void refresh()), [refresh])

  const installJob = usePackageJob(() => void refresh())
  const adapterInstalled = packages?.some((p) => p.includes('pi-mcp-adapter')) ?? false

  /** Run one reconnect for a row and keep its verdict. */
  const track = async (
    serverName: string,
    via: CheckVia,
    run: () => Promise<ConnectorCheckResult>,
  ): Promise<void> => {
    setChecks((c) => ({ ...c, [serverName]: { status: 'running', via } }))
    let result: ConnectorCheckResult
    try {
      result = await run()
    } catch (err) {
      result = { serverName, outcome: 'unknown', detail: errorText(err) }
    }
    setChecks((c) => ({ ...c, [serverName]: { status: 'done', via, result } }))
  }

  /**
   * Test one connector: the adapter reconnects it and reports what happened.
   * Needs no session, so this works from the home screen — which is where the
   * question "is this thing up?" is actually asked. It runs in a throwaway pi,
   * so an open session's connection is untouched; Reload is the one for that.
   */
  const runCheck = (serverName: string): Promise<void> =>
    track(serverName, 'test', () =>
      window.phosphor.invoke('mcp:checkServer', serverName, workspacePath ?? undefined),
    )

  /** Reload one server inside the active session. */
  const runReload = (sessionId: string, serverName: string): Promise<void> =>
    track(serverName, 'reload', () => useConnectorsStore.getState().reload(sessionId, serverName))

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
    <div className="max-w-2xl">
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
      <div className="mt-2 space-y-2">
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
              onReload={() => {
                if (activeSessionId) void runReload(activeSessionId, server.name)
              }}
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
          <div className="mt-2 space-y-2">
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

/**
 * Which reconnect produced a row's verdict: Test, in a throwaway pi, or
 * Reload, in the active session.
 */
type CheckVia = 'test' | 'reload'

/** One row's reconnect: in flight, or the verdict it produced. */
type ConnectorCheck =
  | { status: 'running'; via: CheckVia }
  | { status: 'done'; via: CheckVia; result: ConnectorCheckResult }

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
  onReload,
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
  onReload: () => void
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
  const running = check?.status === 'running' ? check.via : undefined
  // Sign-in is an OAuth flow, so only a remote server has one. Reload is any
  // server the session can reconnect — the adapter refuses a disabled one.
  const showAction = action === 'sign-in' ? signInable : !disabled
  const toolTotal = cache?.tools.length ?? 0

  return (
    <div
      className="border-border bg-surface rounded-xl border"
      data-testid={`connector-${entry?.id ?? server.name}`}
    >
      {/* Identity on the left, the two actions on the right. The actions never
          wrap: the left column is the one that gives up width. */}
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={clsx(
                'min-w-0 truncate text-lg font-semibold',
                disabled && 'text-text-tertiary line-through',
              )}
              title={server.name}
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
                    ? `Last ${checked.via} — ${checked.result.detail}`
                    : checked.via === 'reload'
                      ? "Result of the last reload, which reconnected the session's connection"
                      : 'Result of the last test, which reconnected the server'
                }
              >
                <span
                  className={clsx('h-1.5 w-1.5 rounded-full', CHECK_DOT[checked.result.outcome])}
                />
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
          </div>
          {entry && (
            <div className="text-text-secondary mt-0.5 text-base leading-snug">{entry.summary}</div>
          )}
          <div className="text-text-tertiary mt-0.5 truncate font-mono text-sm" title={transport}>
            {transport}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            className="whitespace-nowrap"
            onClick={onCheck}
            disabled={Boolean(running)}
            title="Reconnect this server in a separate, throwaway pi and report what happened. Checks the server, not your open session. No session needed, no tokens spent."
          >
            {running === 'test' ? 'Testing…' : 'Test'}
          </Button>
          {showAction && (
            <Button
              size="sm"
              className="whitespace-nowrap"
              variant={action === 'sign-in' && state === 'needs-auth' ? 'primary' : undefined}
              disabled={action === 'reload' && Boolean(running)}
              title={
                action === 'reload'
                  ? "Drop this session's connection to the server and open a fresh one, re-reading its tools. Uses the config the session started with, and does not re-authorize."
                  : undefined
              }
              onClick={() => {
                // Reload rides the adapter's own /mcp reconnect, which needs
                // the process holding the connection. Signing in does not,
                // and runs headless.
                if (action === 'sign-in') {
                  void useConnectorsStore.getState().connect(server.name, sessionId ?? undefined)
                } else {
                  onReload()
                }
              }}
            >
              {running === 'reload' ? 'Reloading…' : connectorActionLabel(action)}
            </Button>
          )}
        </div>
      </div>

      {(directTools.length > 0 ||
        (checked && 'detail' in checked.result && checked.result.detail) ||
        flow) && (
        <div className="px-3.5 pb-2.5">
          {directTools.length > 0 && (
            <div className="text-warning text-sm">
              direct: <span className="font-mono">{directTools.slice(0, 4).join(', ')}</span>
              {directTools.length > 4 && ` +${directTools.length - 4}`} — these register as
              top-level tools instead of going through the <span className="font-mono">mcp</span>{' '}
              gateway, so they cost their full schema in every request.
            </div>
          )}

          {checked && 'detail' in checked.result && checked.result.detail && (
            <div
              className={clsx(
                'mt-1 text-sm first:mt-0',
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
      )}

      {/* Settings for the row, and the tool disclosure. */}
      <div className="border-border text-text-tertiary flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-3.5 py-2 text-sm">
        {toolTotal > 0 ? (
          <button
            onClick={() => setShowTools((s) => !s)}
            aria-expanded={showTools}
            className="hover:text-text flex items-center gap-1.5"
          >
            <ChevronIcon size={8} expanded={showTools} />
            {toolTotal} tool{toolTotal === 1 ? '' : 's'}
          </button>
        ) : (
          <span title="The adapter caches a server's tool list the first time it connects">
            no tools cached yet
          </span>
        )}
        {server.shadows.length > 0 && (
          <span title="Lower-precedence files also define this server">
            shadows {server.shadows.map((s) => SCOPE_LABELS[s]).join(', ')}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <label className="hover:text-text flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={!disabled}
              onChange={(e) => onToggle(!e.target.checked)}
            />
            enabled
          </label>
          {signInable && (
            <label
              className="hover:text-text flex items-center gap-1.5"
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
          <span className="bg-border h-3.5 w-px" aria-hidden />
          <button onClick={onEdit} className="hover:text-text underline-offset-2 hover:underline">
            Edit
          </button>
          <button
            onClick={() => {
              if (signInable) {
                void useConnectorsStore.getState().disconnect(server.name, sessionId ?? undefined)
              }
              onRemove()
            }}
            className="hover:text-danger underline-offset-2 hover:underline"
          >
            Remove
          </button>
        </div>
      </div>

      {showTools && cache && cache.tools.length > 0 && <ToolList tools={cache.tools} />}
    </div>
  )
}

/**
 * A server's cached tools, name and description each. Filterable once the
 * list is long enough that scanning it is the slow way — Linear alone
 * offers dozens.
 */
function ToolList({ tools }: { tools: McpCachedTool[] }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(needle) ||
          tool.description?.toLowerCase().includes(needle),
      )
    : tools

  return (
    <div className="border-border border-t px-3.5 py-2.5">
      {tools.length > 8 && (
        <TextInput
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${tools.length} tools`}
          className="mb-2 w-full"
        />
      )}
      <ul className="divide-border max-h-80 divide-y overflow-y-auto">
        {shown.map((tool) => (
          <li key={tool.name} className="py-1.5 first:pt-0 last:pb-0">
            <div className="text-text font-mono text-sm break-all">{tool.name}</div>
            {tool.description && (
              <div
                className="text-text-tertiary mt-0.5 line-clamp-2 text-sm leading-snug"
                title={tool.description}
              >
                {tool.description}
              </div>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="text-text-tertiary py-1.5 text-sm">No tool matches “{query.trim()}”.</li>
        )}
      </ul>
      <div className="text-text-tertiary mt-2 text-xs">
        Cached by the adapter from the server&apos;s last connection.
      </div>
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

  const hasOptions = Boolean(entry.variants || entry.readOnlyUrl || needsClientId || entry.setup)

  return (
    <div
      className="border-border bg-surface rounded-xl border"
      data-testid={`connector-${entry.id}`}
    >
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold">{entry.name}</div>
          <div className="text-text-secondary mt-0.5 text-base leading-snug">{entry.summary}</div>
          {entry.caveat && (
            <div className="text-text-tertiary mt-1 text-sm leading-snug">{entry.caveat}</div>
          )}
          <div className="text-text-tertiary mt-0.5 truncate font-mono text-sm" title={url}>
            {url}
          </div>
        </div>
        <Button
          variant="primary"
          size="sm"
          className="shrink-0 whitespace-nowrap"
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

      {hasOptions && (
        <div className="border-border text-text-secondary border-t px-3.5 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                />
                read-only
              </label>
            )}
            {needsClientId && (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <TextInput
                  size="sm"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="client ID"
                  className="min-w-40 flex-1 font-mono"
                />
                <TextInput
                  size="sm"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="client secret (optional)"
                  className="min-w-48 flex-1 font-mono"
                />
              </div>
            )}
          </div>
          {entry.setup && <SetupSteps setup={entry.setup} />}
        </div>
      )}
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
    <div className="text-text-tertiary mt-1.5 text-sm first:mt-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="hover:text-text flex items-center gap-1.5"
      >
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
