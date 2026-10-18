import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsSection,
} from '@shared/machine-settings'
import { parseSettingsPatch } from '@shared/machine-settings'
const states = new Map<string, { revision: number; values: Map<string, MachineSettings> }>()
/** Machine-keyed demo state, never a local-machine read or persistent credential store. */
export function mockSettingsRead(
  hostId: string,
  section: MachineSettingsSection,
  repositoryId?: string,
): MachineSettings {
  let host = states.get(hostId)
  if (!host) {
    host = { revision: 1, values: new Map() }
    states.set(hostId, host)
  }
  const key = `${section}/${repositoryId ?? ''}`
  let value = host.values.get(key)
  if (!value) {
    const tag = hostId[0] === '0' ? 'demo' : `bee${hostId[0]}`
    const samples: Omit<MachineSettings, 'section' | 'revision' | 'repositoryId'> = {
      providers: {
        providers: [
          ['anthropic', 'Claude Pro/Max'],
          ['openai-codex', 'ChatGPT'],
          ['github-copilot', 'GitHub Copilot'],
          ['kimi-for-coding', 'Kimi'],
          ['openrouter', 'OpenRouter'],
          ['radius', 'Radius'],
          ['xai', 'xAI'],
        ].map(([id, name]) => ({
          id: id!,
          name: name!,
          status: id === 'anthropic' ? 'ready' : 'not_ready',
        })),
        claude: { provider: 'ok', cli: 'ok', auth: 'ok' },
        authenticating: false,
        mode: 'ordered',
        accounts: [
          {
            id: 'default',
            label: `dev@${tag}.example`,
            email: `dev@${tag}.example`,
            plan: 'max',
            loggedIn: true,
            cooldownUntil: null,
            usage: null,
            lanes: [],
          },
          {
            id: 'd8736746-ea12-452b-a492-411a74fba4f8',
            label: `work@${tag}.example`,
            plan: 'team',
            loggedIn: true,
            cooldownUntil: Date.now() + 3600_000,
            usage: null,
            lanes: [],
          },
        ],
      },
      connectors: {
        trusted: repositoryId ? true : null,
        legacy: false,
        malformed: false,
        servers: [
          {
            name: 'github',
            scope: 'global',
            transport: 'https',
            enabled: true,
            exposure: 'codemode',
          },
        ],
      },
      agent: {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-5',
        defaultThinkingLevel: 'medium',
        contextBudget: '200k',
        autoNameLanes: true,
      },
      resources: {
        packages: [
          {
            spec: 'npm:@saccolabs/pi-claude-cli',
            name: '@saccolabs/pi-claude-cli',
            version: '0.10.0',
            installed: true,
            scope: 'global',
          },
        ],
      },
      advanced: {
        platform: 'linux',
        hostVersion: '1.0.0-demo',
        configPath: `/home/${tag}/.config/phosphor/host.json`,
        piAgentDir: `/home/${tag}/.pi/agent`,
        path: [`/home/${tag}/.local/bin`, '/usr/bin', '/bin'],
        environment: [{ name: 'EXAMPLE_API_KEY', available: false, passed: false }],
      },
    }
    value = {
      section,
      revision: '',
      ...(repositoryId ? { repositoryId } : {}),
      [section]: samples[section],
    }
    host.values.set(key, value)
  }
  return structuredClone({ ...value, revision: host.revision.toString(16).padStart(64, '0') })
}
export function mockSettingsPatch(hostId: string, patch: MachineSettingsPatch): MachineSettings {
  const input = parseSettingsPatch(patch)
  if (!input) throw new Error('Invalid settings change.')
  const current = mockSettingsRead(hostId, input.section, input.repositoryId)
  if (current.revision !== input.revision)
    throw new Error('Settings changed. Reload before saving.')
  const change = input.change
  if (current.agent && change.type === 'agent.patch') Object.assign(current.agent, change.patch)
  if (current.providers) {
    if (change.type === 'claude.routing') {
      current.providers.mode = change.mode
      current.providers.pinnedId = change.pinnedId
    }
    if (change.type === 'claude.remove')
      current.providers.accounts = current.providers.accounts.filter(
        (account) => account.id !== change.accountId,
      )
    if (change.type === 'claude.reorder')
      current.providers.accounts.sort((a, b) => change.ids.indexOf(a.id) - change.ids.indexOf(b.id))
  }
  if (current.connectors) {
    if (change.type === 'mcp.upsert')
      current.connectors.servers.push({
        name: change.name,
        scope: input.repositoryId ? 'project' : 'global',
        transport: change.config.command ? 'stdio' : 'https',
        enabled: change.config.enabled !== false,
        exposure: change.config.exposure ?? 'codemode',
      })
    if (change.type === 'mcp.remove')
      current.connectors.servers = current.connectors.servers.filter(
        (server) => server.name !== change.name,
      )
    if (change.type === 'mcp.enabled') {
      const server = current.connectors.servers.find((server) => server.name === change.name)
      if (server) server.enabled = change.enabled
    }
  }
  const state = states.get(hostId)!
  state.revision++
  state.values.set(`${input.section}/${input.repositoryId ?? ''}`, current)
  return mockSettingsRead(hostId, input.section, input.repositoryId)
}
export function mockSettingsCheck(hostId: string, repositoryId?: string): MachineSettings {
  const value = mockSettingsRead(hostId, 'connectors', repositoryId)
  if (value.connectors) {
    value.connectors.checkedAt = Date.now()
    for (const server of value.connectors.servers)
      server.state = server.enabled ? 'connected' : 'disabled'
  }
  states.get(hostId)!.values.set(`connectors/${repositoryId ?? ''}`, value)
  return value
}
