import { TooltipButton, TooltipLabel } from '@/components/Tooltip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  exposesDirectTools,
  exposureSummary,
  type McpConfigsResult,
  type McpListResult,
  type McpResolvedServer,
  type McpScope,
  type McpServerReport,
} from '@shared/mcp'
import type { PiPackageEntry } from '@shared/models'
import { errorText } from '@shared/errors'
import { useSettingsWorkspace } from '../SettingsMachineScope'
import { useConnectorsStore, type ConnectFlow } from '@/stores/connectors'
import { FlowCard } from '@/features/connectors/FlowCard'
import { MigrationCard, adapterPackages } from '@/features/connectors/MigrationCard'
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
import { STATE_DOT, stateLabel } from '@/features/connectors/mcpStatus'
import { ConfigFileEditor, mcpConfigFile } from '../ConfigFileEditor'

const SCOPE_LABELS: Record<McpScope, string> = {
  global: 'global',
  project: 'project',
}

/** An HTTP server pi signs in to with OAuth: no Authorization header, no provider token. */
function usesOAuth(server: McpResolvedServer): boolean {
  const { config } = server
  if (!config.url || config.auth) return false
  return !Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
}

/**
 * Settings → Connectors: every MCP server a session can reach, in one list.
 *
 * The list is pi's own resolution of its two mcp.json files, enriched with
 * catalog metadata where a server's URL matches a known connector, and with
 * the state `pi mcp list` reports. The catalog is an add affordance, not a
 * separate world. The files themselves live under Advanced, because they are
 * repair tools rather than daily controls.
 *
 * Phosphor never holds a token: it writes mcp.json and runs pi's own
 * `pi mcp login` / `logout`. See docs/mcp.md.
 */
export function ConnectorsTab(): React.JSX.Element {
  const workspacePath = useSettingsWorkspace() ?? undefined
  const [configs, setConfigs] = useState<McpConfigsResult | null>(null)
  const [packages, setPackages] = useState<PiPackageEntry[] | null>(null)
  const [report, setReport] = useState<McpListResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<McpResolvedServer | null>(null)
  const [rawEdit, setRawEdit] = useState<McpScope | null>(null)
  const [advanced, setAdvanced] = useState(false)

  const flows = useConnectorsStore((s) => s.flows)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextConfigs, nextPackages] = await Promise.all([
        window.phosphor.invoke('mcp:readConfigs', workspacePath),
        // Per-scope package entries — pi loads BOTH scopes' packages, so the
        // merged settings view (where a project array shadows global) would
        // miss an adapter installed in the other one.
        window.phosphor.invoke('packages:list', workspacePath),
      ])
      setConfigs(nextConfigs)
      setPackages(nextPackages)
    } catch (err) {
      setError(errorText(err))
    }
  }, [workspacePath])

  /** `pi mcp list`: connect every enabled server once and keep what it says. */
  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setReport(await window.phosphor.invoke('mcp:list', workspacePath))
    } catch (err) {
      setReport({ ok: false, message: errorText(err) })
    } finally {
      setChecking(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const adapters = useMemo(() => adapterPackages(packages ?? []), [packages])
  const legacy = Boolean(configs?.legacy) || adapters.length > 0

  // State is worth one round of connections per visit, not per render: it
  // spawns every local server and opens every remote one.
  const hasServers = (configs?.servers.length ?? 0) > 0
  useEffect(() => {
    if (packages !== null && !legacy && hasServers) void check()
  }, [check, packages, legacy, hasServers])

  // A sign-in that finishes while the tab is open changes what pi can reach;
  // ask again. One that finished before it opened is already in the first check.
  const signedIn = Object.values(flows).filter((flow) => flow.phase === 'connected').length
  const seenSignIns = useRef(signedIn)
  useEffect(() => {
    if (signedIn > seenSignIns.current) void check()
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

  const reports = report?.ok ? report.servers : []
  const projectFile = configs?.files.find((file) => file.scope === 'project')
  const untrusted =
    configs?.projectTrust && !configs.projectTrust.trusted && projectFile?.exists
      ? configs.projectTrust
      : null
  const problems = [...(configs?.errors ?? []), ...(report?.ok ? report.errors : [])]

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

          {report && !report.ok && (
            <div className="text-danger mt-3 text-sm">
              Could not check servers: {report.message}
            </div>
          )}

          {/* Configured servers, as pi resolves them. Kept FIRST so their
              controls are what a reader reaches for by default. */}
          <div className="mt-5 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Connected</h3>
            <div className="flex items-center gap-1.5">
              {hasServers && (
                <Button
                  size="sm"
                  onClick={() => void check()}
                  disabled={checking}
                  tooltip={{
                    label: 'Check connections',
                    description: 'No session, no tokens spent',
                  }}
                >
                  {checking ? 'Checking…' : 'Check again'}
                </Button>
              )}
              <Button size="sm" onClick={() => setAdding(true)}>
                Add custom server…
              </Button>
            </div>
          </div>
          <div className="mt-2 space-y-2">
            {configs?.servers.map((server) => (
              <ConfiguredRow
                key={server.name}
                server={server}
                entry={connectorForUrl(server.config.url)}
                report={reports.find((r) => r.name === server.name)}
                checking={checking}
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

/** One configured server, with what pi last said about it. */
function ConfiguredRow({
  server,
  entry,
  report,
  checking,
  flow,
  onSignIn,
  onToggle,
  onRemove,
  onEdit,
}: {
  server: McpResolvedServer
  entry: ConnectorEntry | undefined
  report: McpServerReport | undefined
  checking: boolean
  flow?: ConnectFlow
  onSignIn: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
  onEdit: () => void
}): React.JSX.Element {
  const [showTools, setShowTools] = useState(false)
  const disabled = server.config.enabled === false
  const transport = server.config.url
    ? server.config.url
    : [server.config.command, ...(server.config.args ?? [])].join(' ')
  // Config is the truth for on/off; a report from before a toggle is not.
  const state = disabled ? 'disabled' : report?.state
  const oauth = usesOAuth(server)
  const showSignIn = oauth && !disabled && state !== 'connected'
  const exposure = exposureSummary(server.config)
  const tools = !disabled && report ? report.tools : []
  const scopeLabel = server.overridden
    ? 'global · project override'
    : server.replacesGlobal
      ? 'project · replaces global'
      : SCOPE_LABELS[server.scope]

  return (
    <div
      className="border-border bg-surface rounded-xl border"
      data-testid={`connector-${entry?.id ?? server.name}`}
    >
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={clsx(
                'min-w-0 truncate text-lg font-semibold',
                disabled && 'text-text-tertiary line-through',
              )}
              data-tooltip={server.name}
            >
              {server.name}
            </span>
            <span className="bg-bg-secondary text-text-tertiary shrink-0 rounded px-1.5 py-px text-xs">
              {scopeLabel}
            </span>
            {state ? (
              <span className="text-text-secondary flex shrink-0 items-center gap-1.5 text-sm">
                <span className={clsx('h-1.5 w-1.5 rounded-full', STATE_DOT[state])} />
                {stateLabel({ state, tools })}
              </span>
            ) : (
              <span className="text-text-tertiary shrink-0 text-sm">
                {checking ? 'checking…' : 'not checked'}
              </span>
            )}
          </div>
          {entry && (
            <div className="text-text-secondary mt-0.5 text-base leading-snug">{entry.summary}</div>
          )}
          <div
            className="text-text-tertiary mt-0.5 truncate font-mono text-sm"
            data-tooltip={transport}
          >
            {transport}
          </div>
        </div>

        {showSignIn && (
          <Button
            size="sm"
            className="shrink-0 whitespace-nowrap"
            variant={state === 'needs-auth' ? 'primary' : undefined}
            onClick={onSignIn}
          >
            Sign in
          </Button>
        )}
      </div>

      {((report?.error && !disabled) || exposesDirectTools(server.config) || flow) && (
        <div className="px-3.5 pb-2.5">
          {report?.error && !disabled && (
            <div className="text-danger text-sm break-words">{report.error}</div>
          )}
          {exposesDirectTools(server.config) && (
            <div className="text-warning mt-1 text-sm first:mt-0">
              Direct tools are declared on every request, so they cost their full schema each time.
            </div>
          )}
          {flow && <FlowCard serverName={server.name} flow={flow} />}
        </div>
      )}

      {/* Settings for the row, and the tool disclosure. */}
      <div className="border-border text-text-tertiary flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-3.5 py-2 text-sm">
        {tools.length > 0 ? (
          <TooltipButton
            onClick={() => setShowTools((s) => !s)}
            aria-expanded={showTools}
            className="hover:text-text flex items-center gap-1.5"
          >
            <ChevronIcon size={8} expanded={showTools} />
            {tools.length} tool{tools.length === 1 ? '' : 's'}
          </TooltipButton>
        ) : null}
        <span data-tooltip="How its tools reach the model. Change it in Edit.">
          exposure: {exposure ?? 'codemode'}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <TooltipLabel className="hover:text-text flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={!disabled}
              onChange={(e) => onToggle(e.target.checked)}
            />
            enabled
          </TooltipLabel>
          <span className="bg-border h-3.5 w-px" aria-hidden />
          <TooltipButton
            onClick={onEdit}
            className="hover:text-text underline-offset-2 hover:underline"
          >
            Edit
          </TooltipButton>
          <TooltipButton
            onClick={onRemove}
            className="hover:text-danger underline-offset-2 hover:underline"
          >
            Remove
          </TooltipButton>
        </div>
      </div>

      {showTools && tools.length > 0 && <ToolList tools={tools} />}
    </div>
  )
}

/** A server's tool names, filterable once the list is long. */
function ToolList({ tools }: { tools: string[] }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle ? tools.filter((tool) => tool.toLowerCase().includes(needle)) : tools

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
      <ul className="max-h-80 overflow-y-auto">
        {shown.map((tool) => (
          <li key={tool} className="text-text py-0.5 font-mono text-sm break-all">
            {tool}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="text-text-tertiary py-1.5 text-sm">No tool matches “{query.trim()}”.</li>
        )}
      </ul>
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
  const missingCredential = needsClientId
    ? !clientId.trim()
      ? 'Paste a client ID first'
      : entry.secretRequired && !clientSecret.trim()
        ? 'Paste the client secret too'
        : undefined
    : undefined

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
          <div className="text-text-tertiary mt-0.5 truncate font-mono text-sm" data-tooltip={url}>
            {url}
          </div>
        </div>
        <Button
          variant="primary"
          size="sm"
          className="shrink-0 whitespace-nowrap"
          // Slack and Google cannot be one click: they support no dynamic
          // registration and need a registered client up front. Showing that as
          // a disabled button beats letting `buildConnectorConfig` throw into
          // the error banner.
          disabled={Boolean(missingCredential)}
          tooltip={
            missingCredential
              ? { label: 'Add connector', description: missingCredential }
              : undefined
          }
          aria-description={
            missingCredential
              ? `${entry.name} has no dynamic registration. Paste the client ${entry.secretRequired ? 'ID and secret' : 'ID'} of an app you registered.`
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
              <TooltipLabel className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                />
                read-only
              </TooltipLabel>
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
                  type="password"
                  size="sm"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={entry.secretRequired ? 'client secret' : 'client secret (optional)'}
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
      <TooltipButton
        onClick={() => setOpen((o) => !o)}
        className="hover:text-text flex items-center gap-1.5"
      >
        <ChevronIcon size={8} expanded={open} />
        Set up the app
      </TooltipButton>

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
            <TooltipButton
              className="underline-offset-2 hover:underline"
              onClick={() => {
                void navigator.clipboard.writeText(setup.snippet?.text ?? '')
                setCopied(true)
              }}
            >
              {copied ? 'copied' : 'copy'}
            </TooltipButton>
          </div>
          <pre className="border-border bg-bg-secondary mt-1 max-h-48 overflow-auto rounded border p-2 font-mono text-sm">
            {setup.snippet.text}
          </pre>
        </div>
      )}
    </div>
  )
}
