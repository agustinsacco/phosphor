import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { MachineSettings, MachineSettingsSection } from '@phosphor/shared/machine-settings'
import type { FeatureContext } from '../features/feature'
import type { HostStore } from '../lanes/store'
import type { HostRuntime } from '../session/runtime'
import type { HostClaudeAccounts } from '../providers/accounts'
import { webSearchConfigPath } from '@phosphor/session-runtime/pi/pi-paths'
import {
  HOST_FILE_POLICY,
  readSettingsBytes,
  settingsFile,
  SettingsFailure,
} from '@phosphor/session-runtime/pi/settings-file'

export interface MachineSettingsOptions {
  context: FeatureContext
  configPath: string
  env: Record<string, string>
  store: Pick<HostStore, 'listLanes' | 'listRepositories'>
  runtime: Pick<HostRuntime, 'accountForSession'>
  accounts: HostClaudeAccounts
  pi: { binaryPath: string; prefixArgs: string[] }
  authenticating(): boolean
  sessionFor(laneId: string): string | null
}
export interface ConnectorCheck {
  at: number
  revision: string
  servers: Map<string, { state: string; tools: number }>
}
export const settingsHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** State shared by section owners within one serialized configuration service. */
export class SettingsContext {
  readonly agentDir: string
  readonly dirs: { home: string; piAgent: string; xdgConfig: string }
  readonly connectorChecks = new Map<string, ConnectorCheck>()
  providerCatalogue:
    { at: number; providers: NonNullable<MachineSettings['providers']>['providers'] } | undefined
  connectorGeneration = 0

  constructor(readonly options: MachineSettingsOptions) {
    this.agentDir = options.env.PI_CODING_AGENT_DIR ?? join(options.context.home, '.pi', 'agent')
    this.dirs = {
      home: options.context.home,
      piAgent: this.agentDir,
      xdgConfig: options.context.env.XDG_CONFIG_HOME ?? join(options.context.home, '.config'),
    }
  }

  invalidateConnectors = () => {
    this.connectorGeneration++
    this.connectorChecks.clear()
  }

  workspace = (id?: string): string | undefined => {
    if (!id) return undefined
    const repo = this.options.store.listRepositories().find((repo) => repo.id === id)
    if (!repo) throw new SettingsFailure('bad-request', 'Unknown Host folder.')
    // Repository ids bind their admitted realpath. Never follow a replacement symlink.
    if (realpathSync.native(repo.path) !== repo.path)
      throw new SettingsFailure('forbidden', 'The Host folder identity changed.')
    return repo.path
  }

  private files(section: MachineSettingsSection, cwd?: string) {
    if (section === 'agent')
      return [
        join(this.agentDir, 'settings.json'),
        ...(cwd ? [join(cwd, '.pi', 'settings.json'), join(this.agentDir, 'trust.json')] : []),
        this.options.configPath,
      ]
    if (section === 'connectors')
      return [
        join(this.agentDir, 'mcp.json'),
        join(this.agentDir, 'settings.json'),
        ...(cwd ? [join(cwd, '.pi', 'mcp.json'), join(this.agentDir, 'trust.json')] : []),
      ]
    // Packages are listed in pi's settings; Web access keys in pi-web-access's file.
    // The snapshot and every commit check this same revision.
    if (section === 'resources')
      return [
        join(this.agentDir, 'settings.json'),
        ...(cwd ? [join(cwd, '.pi', 'settings.json')] : []),
        webSearchConfigPath(this.options.env, this.options.context.home),
      ]
    return []
  }

  revision(section: MachineSettingsSection, cwd?: string) {
    // Resources must load beside a Web access file the Host will not edit, so
    // its revision hashes bytes and marks such a file instead of failing.
    const revision =
      section === 'resources'
        ? (path: string) => {
            try {
              return readSettingsBytes(path, HOST_FILE_POLICY).revision
            } catch (error) {
              if (error instanceof SettingsFailure) return 'refused'
              throw error
            }
          }
        : (path: string) => settingsFile(path, HOST_FILE_POLICY).revision
    return settingsHash([
      ...this.files(section, cwd).map(revision),
      ...(section === 'connectors'
        ? [
            existsSync(join(this.agentDir, 'mcp-adapter.json')),
            !!cwd && existsSync(join(cwd, '.pi', 'mcp-adapter.json')),
          ]
        : []),
    ])
  }
}
