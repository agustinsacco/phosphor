import { useEffect, useMemo, useRef } from 'react'
import { errorText } from '@shared/errors'
import {
  exposureSummary,
  mcpUsesOAuth,
  type McpConfigsResult,
  type McpResolvedServer,
  type McpScope,
} from '@shared/mcp'
import type { SettingsNoticeProps } from '@/components/form'
import { buildConnectorConfig, connectorForUrl } from '@/features/connectors/catalog'
import { adapterPackages } from '@/features/connectors/MigrationCard'
import {
  useConnectorChecks,
  type ConnectorCheckView,
} from '@/features/connectors/useConnectorChecks'
import { useConnectorConfigs } from '@/features/connectors/useConnectorConfigs'
import { useConnectorsStore, type ConnectFlow } from '@/stores/connectors'
import { useSettingsWorkspace } from '../../SettingsMachineScope'
import { useSettingsUiStore } from '../../settingsUiStore'
import type { ConnectorOp, ConnectorView, ConnectorsSource } from './source'

const NO_SERVERS: McpResolvedServer[] = []

function endpoint(server: McpResolvedServer): string {
  if (!server.config.url) return server.config.command ?? ''
  try {
    const url = new URL(server.config.url)
    return url.origin + url.pathname
  } catch {
    return 'Invalid endpoint'
  }
}

function connectorView(
  server: McpResolvedServer,
  folder: boolean,
  check: ConnectorCheckView | undefined,
  flow: ConnectFlow | undefined,
): ConnectorView {
  return {
    name: server.name,
    scope: server.scope,
    inherited: folder && server.scope === 'global',
    overridden: server.overridden === true,
    replacesGlobal: server.replacesGlobal === true,
    transport: server.config.url ? 'https' : 'stdio',
    enabled: server.config.enabled !== false,
    oauth: mcpUsesOAuth(server.config),
    exposure: exposureSummary(server.config) ?? 'codemode',
    endpoint: endpoint(server),
    entry: connectorForUrl(server.config.url),
    status: {
      state: check?.snapshot?.report.state,
      tools: check?.snapshot?.tools.length,
      checking: check?.checking,
      failed: Boolean(check?.error),
    },
    flow,
    inspection: { server, check },
  }
}

/**
 * This Mac's connectors in the chosen scope: pi's global mcp.json at Machine
 * scope, or a folder's merged view, written to its `.pi/mcp.json`. Reloads on
 * focus and every 15 s, and tests each connector on its own when shown.
 */
export function useLocalConnectors(): ConnectorsSource {
  const folder = useSettingsUiStore((s) => s.folder)
  const settingsWorkspace = useSettingsWorkspace()
  const workspacePath = folder ?? undefined
  const scope = folder ? 'project' : 'global'
  const { configs, packages, error, setError, refresh } = useConnectorConfigs(workspacePath)
  const flows = useConnectorsStore((s) => s.flows)
  const adapters = useMemo(() => adapterPackages(packages ?? []), [packages])
  const legacy = Boolean(configs?.legacy) || adapters.length > 0
  const servers = configs?.servers ?? NO_SERVERS
  const checks = useConnectorChecks(
    workspacePath,
    servers,
    configs !== null && packages !== null && !legacy,
  )
  const check = checks.refresh

  // A sign-in that finishes while the page is open changes what pi can reach;
  // ask again. One that finished before it opened is already in the first check.
  const signedIn = Object.values(flows).filter((flow) => flow.phase === 'connected').length
  const seenSignIns = useRef(signedIn)
  useEffect(() => {
    if (signedIn > seenSignIns.current) check()
    seenSignIns.current = signedIn
  }, [signedIn, check])

  const views = useMemo(
    () =>
      servers.map((server) =>
        connectorView(server, folder !== null, checks.checks[server.name], flows[server.name]),
      ),
    [servers, folder, checks.checks, flows],
  )

  const run = localRun({
    scope,
    workspacePath,
    views,
    setError,
    refresh,
    checks,
  })

  const notices = localNotices(configs)

  return {
    caps: { inspect: true, edit: true, rawFiles: true, reviewed: false },
    folder: folder !== null,
    servers: configs && !legacy ? views : null,
    notices,
    error,
    locked: false,
    busy: false,
    canSignIn: true,
    checking: checks.checking,
    slow: checks.slow,
    ...(legacy && packages !== null ? { migration: { workspacePath, adapters } } : {}),
    ...(configs ? { files: { states: configs.files, workspacePath } } : {}),
    laneWorkspace: workspacePath ?? settingsWorkspace ?? undefined,
    run,
    refresh,
  }
}

interface LocalRunContext {
  scope: McpScope
  workspacePath: string | undefined
  views: ConnectorView[]
  setError: (error: string | null) => void
  refresh: () => Promise<void>
  checks: ReturnType<typeof useConnectorChecks>
}

/** This Mac's actions: pi's MCP channels on the chosen scope's file. */
function localRun({ scope, workspacePath, views, setError, refresh, checks }: LocalRunContext) {
  const check = checks.refresh
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await fn()
      await refresh()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }
  const connect = (name: string) => useConnectorsStore.getState().connect(name, workspacePath)
  const invoke = window.phosphor.invoke

  return (op: ConnectorOp): Promise<boolean> => {
    switch (op.type) {
      case 'enabled':
        // A folder switches a machine connector with an override in its own file.
        return act(() => invoke('mcp:setEnabled', scope, workspacePath, op.name, op.enabled))
      case 'remove':
        return act(async () => {
          // Credentials first: pi finds them through the config entry.
          if (views.find((view) => view.name === op.name)?.oauth)
            await invoke('mcp:logout', op.name, workspacePath)
          await invoke('mcp:removeServer', scope, workspacePath, op.name)
        })
      case 'signIn':
        return act(() => connect(op.name))
      case 'signOut':
        return act(async () => {
          await invoke('mcp:logout', op.name, workspacePath)
          void checks.test(op.name)
        })
      case 'test':
        return checks.test(op.name).then(() => true)
      case 'checkAll':
        return refresh().then(() => (check(), true))
      case 'cancelChecks':
        checks.cancel()
        return Promise.resolve(true)
      case 'upsert':
        return act(() => invoke('mcp:upsertServer', scope, workspacePath, op.name, op.config))
      case 'catalogue':
        return act(async () => {
          const config = buildConnectorConfig(op.entry, op.choice)
          await invoke('mcp:upsertServer', scope, workspacePath, op.entry.serverName, config)
          // Adding was never the goal; being signed in is. Add starts the
          // sign-in itself, so it does not read as "Add did nothing".
          await connect(op.entry.serverName)
        })
    }
  }
}

function localNotices(configs: McpConfigsResult | null): SettingsNoticeProps[] {
  const notices: SettingsNoticeProps[] = [...new Set(configs?.errors ?? [])].map((problem) => ({
    tone: 'warning',
    title: problem,
  }))
  const projectFile = configs?.files.find((file) => file.scope === 'project')
  const trust = configs?.projectTrust
  if (trust && !trust.trusted && projectFile?.exists)
    notices.push({
      tone: 'warning',
      title: 'pi ignores this folder’s .pi/mcp.json until you trust the folder.',
      body: `Run pi once in a terminal in ${trust.path} and choose Trust.`,
    })
  return notices
}
