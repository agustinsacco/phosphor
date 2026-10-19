import { delimiter } from 'node:path'
import type { MachineSettings, MachineSettingsSection } from '@phosphor/shared/machine-settings'
import { isMachinePackageSpec } from '@phosphor/shared/machine-settings'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { validateHostConfig } from '../config/schema'
import { HOST_VERSION } from '../version'
import { type SettingsContext, settingsHash } from './context'
import { settingsFile, SettingsFailure } from './files'
import { readProviderSettings } from './provider-settings'
import { readAgentSettings } from './agent-settings'
import { readConnectorSettings } from './connector-settings'

async function readResources(state: SettingsContext, cwd?: string) {
  const packages = await listPackages(cwd, state.agentDir)
  return {
    revision: settingsHash(packages.map((p) => [p.spec, p.version, p.installed])),
    resources: {
      packages: packages.map((p) => ({
        spec: p.kind === 'npm' && isMachinePackageSpec(p.spec) ? p.spec : 'Source managed on Host',
        name: /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(p.name) ? p.name : 'External package',
        version: p.version,
        installed: p.installed,
        scope: p.scope,
      })),
    },
  }
}

function readAdvanced(state: SettingsContext) {
  const { options } = state
  const config = validateHostConfig(settingsFile(options.configPath).raw)
  if (!config.ok) throw new SettingsFailure('bad-request', 'Host config is invalid.')
  const names = config.config.environment?.pass ?? []
  return {
    advanced: {
      platform: process.platform,
      hostVersion: HOST_VERSION,
      configPath: options.configPath,
      piAgentDir: state.agentDir,
      path: (options.env.PATH ?? '').split(delimiter),
      environment: names.map((name) => ({
        name,
        available: options.context.env[name] !== undefined,
        passed: options.env[name] !== undefined,
      })),
    },
  }
}

export function createSettingsSnapshot(state: SettingsContext) {
  return async function snapshot(
    section: MachineSettingsSection,
    repositoryId?: string,
    quick = false,
  ): Promise<MachineSettings> {
    const cwd = state.workspace(repositoryId)
    const base = {
      section,
      revision: state.revision(section, cwd),
      ...(repositoryId ? { repositoryId } : {}),
    }
    if (section === 'providers') return { ...base, ...(await readProviderSettings(state, quick)) }
    if (section === 'connectors')
      return {
        ...base,
        ...(await readConnectorSettings(state, base.revision, repositoryId, cwd)),
      }
    if (section === 'agent') return { ...base, ...(await readAgentSettings(state, cwd)) }
    if (section === 'resources') return { ...base, ...(await readResources(state, cwd)) }
    return { ...base, ...readAdvanced(state) }
  }
}
export type SettingsSnapshot = ReturnType<typeof createSettingsSnapshot>
