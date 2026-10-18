import { createHash } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { MachineSettings, MachineSettingsSection } from '@phosphor/shared/machine-settings'
import {
  isMachinePackageSpec,
  parseSettingsPatch,
  parseSettingsRead,
} from '@phosphor/shared/machine-settings'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { readMcpConfigs, serverProblem } from '@phosphor/session-runtime/pi/mcp-config'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { type HostFeature, type FeatureContext } from '../features/feature'
import { featureInspection } from '../features/machine'
import { inspectClaude } from '../machine/claude'
import { validateHostConfig } from '../config/schema'
import type { HostStore } from '../lanes/store'
import type { HostRuntime } from '../session/runtime'
import type { HostClaudeAccounts } from '../providers/accounts'
import { HOST_VERSION } from '../version'
import { mcpNamespace } from '@phosphor/shared/mcp'
import { cooldownFromUsage, selectAccount } from '@phosphor/session-runtime/claude/routing'
import { saveSettingsFile, settingsFile, SettingsFailure, withSettingsFileLock } from './files'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createMachineSettings(options: {
  context: FeatureContext
  configPath: string
  env: Record<string, string>
  store: Pick<HostStore, 'listLanes' | 'listRepositories'>
  runtime: Pick<HostRuntime, 'accountForSession'>
  accounts: HostClaudeAccounts
  pi: { binaryPath: string; prefixArgs: string[] }
  authenticating(): boolean
  sessionFor(laneId: string): string | null
}) {
  const { context, accounts } = options
  const agentDir = options.env.PI_CODING_AGENT_DIR ?? join(context.home, '.pi', 'agent')
  const dirs = {
    home: context.home,
    piAgent: agentDir,
    xdgConfig: context.env.XDG_CONFIG_HOME ?? join(context.home, '.config'),
  }
  const connectorChecks = new Map<
    string,
    { at: number; revision: string; servers: Map<string, { state: string; tools: number }> }
  >()
  let providerCatalogue:
    { at: number; providers: NonNullable<MachineSettings['providers']>['providers'] } | undefined
  let connectorGeneration = 0
  function invalidateConnectors() {
    connectorGeneration++
    connectorChecks.clear()
  }
  let pending = 0
  let tail: Promise<unknown> = Promise.resolve()
  function workspace(id?: string): string | undefined {
    if (!id) return undefined
    const repo = options.store.listRepositories().find((repo) => repo.id === id)
    if (!repo) throw new SettingsFailure('bad-request', 'Unknown Host folder.')
    // Repository ids bind their admitted realpath. Never follow a replacement symlink.
    if (realpathSync.native(repo.path) !== repo.path)
      throw new SettingsFailure('forbidden', 'The Host folder identity changed.')
    return repo.path
  }
  function files(section: MachineSettingsSection, cwd?: string) {
    if (section === 'agent')
      return [
        join(agentDir, 'settings.json'),
        ...(cwd ? [join(cwd, '.pi', 'settings.json'), join(agentDir, 'trust.json')] : []),
        options.configPath,
      ]
    if (section === 'connectors')
      return [
        join(agentDir, 'mcp.json'),
        join(agentDir, 'settings.json'),
        ...(cwd ? [join(cwd, '.pi', 'mcp.json'), join(agentDir, 'trust.json')] : []),
      ]
    return []
  }
  function revision(section: MachineSettingsSection, cwd?: string) {
    return hash([
      ...files(section, cwd).map((path) => settingsFile(path).revision),
      ...(section === 'connectors'
        ? [
            existsSync(join(agentDir, 'mcp-adapter.json')),
            !!cwd && existsSync(join(cwd, '.pi', 'mcp-adapter.json')),
          ]
        : []),
    ])
  }
  async function snapshot(
    section: MachineSettingsSection,
    repositoryId?: string,
    quick = false,
  ): Promise<MachineSettings> {
    const cwd = workspace(repositoryId)
    const base = {
      section,
      revision: revision(section, cwd),
      ...(repositoryId ? { repositoryId } : {}),
    }
    if (section === 'providers') {
      const catalogue = async () => {
        if (quick && providerCatalogue && Date.now() - providerCatalogue.at < 60_000)
          return providerCatalogue.providers
        const report = await featureInspection(context, { configPath: options.configPath })
        const providers = (report.report.providers ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
        }))
        providerCatalogue = { at: Date.now(), providers }
        return providers
      }
      const [providers, state, packages] = await Promise.all([
        catalogue(),
        accounts.accountViews(),
        listPackages(undefined, agentDir),
      ])
      const claude = await inspectClaude(packages, { env: options.env, secrets: [] })
      const selectedId = selectAccount(state.prefs, { nowMs: Date.now() }).account?.id
      const selected = state.views.find((view) => view.account.id === selectedId)
      if (claude.cli === 'ok' && selected)
        claude.auth = selected.auth.ok ? (selected.auth.loggedIn ? 'ok' : 'signed-out') : 'unknown'
      const lanes = options.store.listLanes().filter((lane) => lane.removedAt === null)
      return {
        ...base,
        revision: hash(state.prefs),
        providers: {
          providers,
          claude,
          mode: state.prefs.mode,
          pinnedId: state.prefs.pinnedId,
          authenticating: options.authenticating(),
          accounts: state.views.map((view) => ({
            id: view.account.id,
            label: view.account.label,
            email: view.account.email,
            plan: view.account.plan,
            organization: view.account.organization,
            loggedIn: view.auth.ok ? view.auth.loggedIn === true : null,
            cooldownUntil: view.cooldownUntil,
            usage: view.usage ? { ...view.usage, contributing: null } : null,
            lanes: lanes.flatMap((lane) => {
              const sessionId = options.sessionFor(lane.laneId)
              const id = sessionId
                ? options.runtime.accountForSession(sessionId)
                : lane.sessionFile
                  ? state.prefs.bindings[lane.sessionFile]
                  : undefined
              return id === view.account.id
                ? [
                    {
                      id: lane.laneId,
                      title: lane.title ?? 'Untitled lane',
                      active: sessionId !== null,
                    },
                  ]
                : []
            }),
          })),
        },
      }
    }
    if (section === 'connectors') {
      const configs = await readMcpConfigs(cwd, dirs)
      const previous = connectorChecks.get(repositoryId ?? '')
      const checked =
        previous?.revision === base.revision && Date.now() - previous.at < 60_000
          ? previous
          : undefined
      return {
        ...base,
        connectors: {
          ...(checked ? { checkedAt: checked.at } : {}),
          servers: configs.servers.map((server) => ({
            name: server.name,
            scope: server.scope,
            transport: server.config.url ? 'https' : 'stdio',
            enabled: server.config.enabled !== false,
            exposure: server.config.exposure ?? 'codemode',
            ...(checked?.servers.get(server.name) ?? {}),
          })),
          ...(configs.projectTrust?.trusted === false
            ? {
                inactiveNames: (
                  configs.files.find((file) => file.scope === 'project')?.serverNames ?? []
                )
                  .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))
                  .slice(0, 128),
              }
            : {}),
          trusted: configs.projectTrust?.trusted ?? null,
          legacy: configs.legacy,
          malformed: configs.files.some((file) => file.malformed) || configs.errors.length > 0,
        },
      }
    }
    if (section === 'agent') {
      const global = settingsFile(join(agentDir, 'settings.json')).raw
      const configs = await readMcpConfigs(cwd, dirs)
      // This is an editor: show saved folder values even before trust. Runtime
      // readAgentSettings separately excludes them until pi trusts the folder.
      const project = cwd ? settingsFile(join(cwd, '.pi', 'settings.json')).raw : {}
      const effective = { ...global, ...project }
      const host = validateHostConfig(settingsFile(options.configPath).raw)
      if (!host.ok)
        throw new SettingsFailure('bad-request', 'Host config is invalid. Nothing was overwritten.')
      return {
        ...base,
        ...(cwd ? { projectTrusted: configs.projectTrust?.trusted ?? false } : {}),
        agent: {
          ...(typeof effective.defaultProvider === 'string'
            ? { defaultProvider: effective.defaultProvider }
            : {}),
          ...(typeof effective.defaultModel === 'string'
            ? { defaultModel: effective.defaultModel }
            : {}),
          ...(typeof effective.defaultThinkingLevel === 'string'
            ? {
                defaultThinkingLevel: effective.defaultThinkingLevel as NonNullable<
                  MachineSettings['agent']
                >['defaultThinkingLevel'],
              }
            : {}),
          contextBudget: host.config.contextBudget ?? '',
          autoNameLanes: host.config.autoNameLanes !== false,
        },
      }
    }
    if (section === 'resources') {
      const packages = await listPackages(cwd, agentDir)
      return {
        ...base,
        revision: hash(packages.map((p) => [p.spec, p.version, p.installed])),
        resources: {
          packages: packages.map((p) => ({
            spec:
              p.kind === 'npm' && isMachinePackageSpec(p.spec) ? p.spec : 'Source managed on Host',
            name: /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(p.name) ? p.name : 'External package',
            version: p.version,
            installed: p.installed,
            scope: p.scope,
          })),
        },
      }
    }
    const config = validateHostConfig(settingsFile(options.configPath).raw)
    if (!config.ok) throw new SettingsFailure('bad-request', 'Host config is invalid.')
    const names = config.config.environment?.pass ?? []
    return {
      ...base,
      advanced: {
        platform: process.platform,
        hostVersion: HOST_VERSION,
        configPath: options.configPath,
        piAgentDir: agentDir,
        path: (options.env.PATH ?? '').split(delimiter),
        environment: names.map((name) => ({
          name,
          available: context.env[name] !== undefined,
          passed: options.env[name] !== undefined,
        })),
      },
    }
  }
  async function apply(raw: unknown, authorized: () => boolean): Promise<MachineSettings> {
    const input = parseSettingsPatch(raw)
    if (!input) throw new SettingsFailure('bad-request', 'Invalid settings change.')
    if (!authorized())
      throw new SettingsFailure('forbidden', 'Configuration access is not granted.')
    const cwd = workspace(input.repositoryId)
    const change = input.change
    const before: MachineSettings =
      input.section === 'providers'
        ? { section: input.section, revision: hash(await accounts.loadAccounts()) }
        : await snapshot(input.section, input.repositoryId)
    if (before.revision !== input.revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
    const commitAllowed = () => {
      if (!authorized()) return false
      if (revision(input.section, cwd) !== input.revision)
        throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
      return true
    }
    if (change.type === 'claude.routing') {
      if (
        change.pinnedId &&
        !(await accounts.loadAccounts()).accounts.some((account) => account.id === change.pinnedId)
      )
        throw new SettingsFailure('bad-request', 'Unknown Claude account.')
      await accounts.setRouting(change.mode, change.pinnedId)
    } else if (change.type === 'claude.remove') {
      // Do not sign an account out under active lanes. Moving/restarting them is explicit.
      if (
        options.store.listLanes().some((lane) => {
          const sessionId = options.sessionFor(lane.laneId)
          return (
            sessionId !== null && options.runtime.accountForSession(sessionId) === change.accountId
          )
        })
      )
        throw new SettingsFailure(
          'bad-request',
          'Stop or move this account’s active lanes before signing it out.',
        )
      await accounts.removeAccount(change.accountId)
    } else if (change.type === 'claude.reorder') await accounts.reorderAccounts(change.ids)
    else if (change.type === 'claude.refreshUsage') await accounts.refreshCooldowns()
    else if (change.type === 'claude.usage') {
      const account = (await accounts.loadAccounts()).accounts.find(
        (a) => a.id === change.accountId,
      )
      if (!account) throw new SettingsFailure('bad-request', 'Unknown Claude account.')
      const usage = await accounts.usage.fetchUsageSnapshot({
        cacheKey: account.id,
        extraEnv: accounts.accountUsageEnv(account),
        force: true,
      })
      if (usage.ok) {
        const until = cooldownFromUsage(usage.snapshot.windows, Date.now())
        if (until !== null) await accounts.holdAccount(account.id, until)
      }
    } else if (change.type === 'agent.patch') {
      const patch = change.patch
      // Host policy fields cannot be mixed into a pi settings patch. Separate commits
      // avoid pretending a multi-file update is atomic.
      const policy = 'contextBudget' in patch || 'autoNameLanes' in patch
      if (
        policy &&
        Object.keys(patch).some((key) => key !== 'contextBudget' && key !== 'autoNameLanes')
      )
        throw new SettingsFailure('bad-request', 'Save Host policy separately from model defaults.')
      const path = policy
        ? options.configPath
        : cwd
          ? join(cwd, '.pi', 'settings.json')
          : join(agentDir, 'settings.json')
      await withSettingsFileLock(path, async () => {
        if (revision('agent', cwd) !== input.revision)
          throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
        const file = settingsFile(path)
        const next = { ...file.raw, ...patch }
        if (policy && !validateHostConfig(next).ok)
          throw new SettingsFailure('bad-request', 'Invalid Host policy.')
        await saveSettingsFile(path, next, file.revision, commitAllowed)
      })
    } else {
      if (before.connectors?.legacy)
        throw new SettingsFailure(
          'bad-request',
          'Migrate pi-mcp-adapter on this Host before changing connectors.',
        )
      const path = cwd ? join(cwd, '.pi', 'mcp.json') : join(agentDir, 'mcp.json')
      await withSettingsFileLock(path, async () => {
        if (revision('connectors', cwd) !== input.revision)
          throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
        const file = settingsFile(path)
        if (file.raw.mcpServers !== undefined && !machineRecord(file.raw.mcpServers))
          throw new SettingsFailure('bad-request', 'Invalid MCP file. Nothing was overwritten.')
        const servers: Record<string, unknown> = Object.assign(
          Object.create(null),
          machineRecord(file.raw.mcpServers) ? file.raw.mcpServers : {},
        )
        if (change.type === 'mcp.upsert') {
          if (Object.keys(servers).length >= 128 || (before.connectors?.servers.length ?? 0) >= 128)
            throw new SettingsFailure(
              'bad-request',
              'This settings page supports at most 128 connectors per scope.',
            )
          if (
            before.connectors?.servers.some(
              (server) =>
                server.name !== change.name &&
                mcpNamespace(server.name) === mcpNamespace(change.name),
            )
          )
            throw new SettingsFailure(
              'bad-request',
              'Connector names cannot share a tool namespace.',
            )
          if (
            serverProblem(change.name, change.config, cwd ? 'project' : 'global') ||
            (change.config.url && change.config.command)
          )
            throw new SettingsFailure('bad-request', 'Invalid MCP server configuration.')
          if (Object.hasOwn(servers, change.name))
            throw new SettingsFailure(
              'bad-request',
              'This connector already exists. Remove it explicitly before replacing its configuration.',
            )
          Object.defineProperty(servers, change.name, {
            value: change.config,
            enumerable: true,
            writable: true,
            configurable: true,
          })
        } else if (change.type === 'mcp.remove') delete servers[change.name]
        else {
          const existing = Object.hasOwn(servers, change.name) ? servers[change.name] : undefined
          if (
            existing === undefined &&
            !before.connectors?.servers.some((server) => server.name === change.name)
          )
            throw new SettingsFailure('bad-request', 'Unknown connector.')
          if (existing !== undefined && !machineRecord(existing))
            throw new SettingsFailure('bad-request', 'Invalid MCP entry.')
          servers[change.name] = {
            ...(existing as Record<string, unknown> | undefined),
            enabled: change.enabled,
          }
        }
        invalidateConnectors()
        await saveSettingsFile(
          path,
          { ...file.raw, mcpServers: servers },
          file.revision,
          commitAllowed,
        )
      })
    }
    return snapshot(input.section, input.repositoryId, true)
  }
  const feature: HostFeature = {
    capability: 'machine.configure',
    methods: ['machine.settings.read', 'machine.settings.patch', 'machine.settings.check'],
    async call(method, params, authorized = () => false) {
      if (!authorized())
        return {
          ok: false,
          error: { code: 'forbidden', message: 'Configuration access is not granted.' },
        }
      if (pending >= 8)
        return { ok: false, error: { code: 'internal', message: 'Settings are busy. Try again.' } }
      pending++
      const run = tail
        .catch(() => {})
        .then(async () => {
          try {
            return await accounts.withAuthorization(authorized, async () => {
              if (!authorized())
                throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
              const read = parseSettingsRead(params)
              if (method === 'machine.settings.check') {
                if (!read || read.section !== 'connectors')
                  throw new SettingsFailure(
                    'bad-request',
                    'Only connector status can be checked here.',
                  )
                const cwd = workspace(read.repositoryId)
                const checkedRevision = revision('connectors', cwd)
                const checkedGeneration = connectorGeneration
                const result = await runPrintMode(
                  options.pi.binaryPath,
                  [...options.pi.prefixArgs, 'mcp', 'list', '--json'],
                  {
                    cwd: cwd ?? context.home,
                    env: options.env,
                    timeoutMs: 25_000,
                  },
                )
                if (!authorized())
                  throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
                if (
                  checkedGeneration !== connectorGeneration ||
                  checkedRevision !== revision('connectors', workspace(read.repositoryId))
                )
                  throw new SettingsFailure(
                    'bad-request',
                    'Configuration or authentication changed during the check. Review and check again.',
                  )
                if (result.error)
                  throw new SettingsFailure(
                    'internal',
                    'Connector status check did not finish. Try again.',
                  )
                let parsed: unknown
                try {
                  parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
                } catch {
                  throw new SettingsFailure('internal', 'pi did not return connector status.')
                }
                if (
                  !machineRecord(parsed) ||
                  !Array.isArray(parsed.servers) ||
                  parsed.servers.length > 128
                )
                  throw new SettingsFailure('internal', 'Invalid connector status.')
                const servers = new Map<string, { state: string; tools: number }>()
                for (const raw of parsed.servers) {
                  if (
                    !machineRecord(raw) ||
                    typeof raw.name !== 'string' ||
                    typeof raw.state !== 'string' ||
                    ![
                      'connected',
                      'needs-auth',
                      'failed',
                      'disconnected',
                      'connecting',
                      'closed',
                      'disabled',
                    ].includes(raw.state)
                  )
                    continue
                  servers.set(raw.name, {
                    state: raw.state,
                    tools: Array.isArray(raw.tools) ? Math.min(raw.tools.length, 10000) : 0,
                  })
                }
                if (connectorChecks.size >= 64 && !connectorChecks.has(read.repositoryId ?? ''))
                  connectorChecks.delete(connectorChecks.keys().next().value!)
                connectorChecks.set(read.repositoryId ?? '', {
                  at: Date.now(),
                  revision: checkedRevision,
                  servers,
                })
              }
              const data =
                method === 'machine.settings.patch'
                  ? await apply(params, authorized)
                  : read
                    ? await snapshot(read.section, read.repositoryId)
                    : null
              if (!data) throw new SettingsFailure('bad-request', 'Invalid settings request.')
              return { ok: true as const, data }
            })
          } catch (error) {
            return {
              ok: false as const,
              error: {
                code: error instanceof SettingsFailure ? error.code : ('internal' as const),
                message:
                  error instanceof SettingsFailure
                    ? error.message
                    : 'Host settings could not be read or changed.',
              },
            }
          }
        })
        .finally(() => {
          pending--
        })
      tail = run
      return run
    },
  }
  return {
    feature,
    snapshot,
    workspace,
    agentDir,
    invalidateConnectors,
  }
}
