import { describe, expect, it } from 'vitest'
import { parseMachineTask, parseSettingsPatch, parseSettingsRead } from './machine-settings'
import { parseMachineSettings } from './machine-settings-result'
import { parseProviderLoginOp } from './host-protocol-providers'
import { parseClientFrame } from './host-protocol'

const revision = 'a'.repeat(64)
const repositoryId = '0123456789abcdef'
const patch = (change: unknown, section = 'connectors', extra = {}) =>
  parseSettingsPatch({ section, revision, change, ...extra })
describe('machine settings boundaries', () => {
  it('refuses connector names that could become CLI options', () => {
    expect(parseMachineTask({ type: 'machine.task', task: 'mcp.logout', name: '--all' })).toBeNull()
    expect(
      parseMachineTask({ type: 'machine.task', task: 'mcp.login', name: '--timeout' }),
    ).toBeNull()
    expect(
      patch({ type: 'mcp.upsert', name: '--all', config: { url: 'https://example.test' } }),
    ).toBeNull()
  })
  it('accepts registered folder ids, never caller paths or UUID repository ids', () => {
    expect(parseSettingsRead({ section: 'connectors', repositoryId })).toBeTruthy()
    for (const id of ['/home/me', '../private', 'd8736746-ea12-452b-a492-411a74fba4f8'])
      expect(parseSettingsRead({ section: 'connectors', repositoryId: id })).toBeNull()
    expect(parseSettingsRead({ section: 'providers', repositoryId })).toBeNull()
    expect(parseSettingsRead({ section: 'agent', path: '/private' })).toBeNull()
  })
  it('requires revisions, section matching and allowlisted policy keys', () => {
    expect(patch({ type: 'agent.patch', patch: { contextBudget: '200k' } }, 'agent')).toBeTruthy()
    expect(
      patch({ type: 'agent.patch', patch: { environment: { pass: ['SSH_AUTH_SOCK'] } } }, 'agent'),
    ).toBeNull()
    expect(
      patch({ type: 'agent.patch', patch: { contextBudget: '200k' } }, 'agent', { repositoryId }),
    ).toBeNull()
    expect(patch({ type: 'mcp.remove', name: 'x' }, 'providers')).toBeNull()
    expect(patch({ type: 'mcp.remove', name: 'x' }, 'connectors', { revision: 'old' })).toBeNull()
    expect(patch({ type: 'agent.patch', patch: { contextBudget: '1' } }, 'agent')).toBeNull()
  })
  it('requires code approval and validates all connector options', () => {
    const make = (config: unknown, approveCode?: true) =>
      patch({ type: 'mcp.upsert', name: 'tools', config, approveCode })
    expect(make({ command: 'npx', args: ['-y', '@vendor/server'] })).toBeNull()
    expect(make({ command: 'npx', args: ['-y', '@vendor/server'] }, true)).toBeTruthy()
    expect(
      make({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private' } }),
    ).toBeTruthy()
    for (const config of [
      { url: 'file:///etc/passwd' },
      { url: 'http://public.example/mcp' },
      { url: 'https://u:secret@example.com/mcp' },
      { url: 'https://example.com', command: 'bash' },
      { url: 'https://example.com', unexpected: true },
      { url: 'https://example.com', headers: { Authorization: 'x\r\nInjected: y' } },
      { command: 'node', args: [42] },
      { command: 'node', env: { KEY: { secret: true } } },
      { url: 'https://example.com', oauth: { callbackPort: -1 } },
    ])
      expect(make(config, true)).toBeNull()
    expect(make({ url: 'http://127.0.0.1:1234/mcp' })).toBeTruthy()
  })
  it('accepts fixed-purpose programs but no caller argv, executable, env or ignored scope', () => {
    expect(
      parseMachineTask({
        type: 'machine.task',
        task: 'package.install',
        name: 'npm:@vendor/tools@1.2.3',
      }),
    ).toBeTruthy()
    expect(
      parseMachineTask({ type: 'machine.task', task: 'mcp.login', name: 'github', repositoryId }),
    ).toBeTruthy()
    expect(parseMachineTask({ type: 'machine.task', task: 'host.update' })).toEqual({
      type: 'machine.task',
      task: 'host.update',
    })
    for (const value of [
      { task: 'shell' },
      { task: 'host.update', name: '1.2.3' },
      { task: 'host.update', repositoryId },
      { task: 'host.update', version: '1.2.3' },
      { task: 'package.install', name: 'npm:pkg; touch /tmp/x' },
      { task: 'package.install', name: 'https://example/x' },
      { task: 'package.install', name: 'npm:pkg', repositoryId },
      { task: 'claude.installCli', name: 'arbitrary' },
      { task: 'claude.installCli', args: ['malicious'] },
      { task: 'folder.trust' },
    ])
      expect(parseMachineTask({ type: 'machine.task', ...value })).toBeNull()
  })
  it('isolates Claude targeting and makes account moves fenced lane ops', () => {
    expect(
      parseProviderLoginOp({ type: 'provider.login', provider: 'claude', addAccount: true }),
    ).toBeTruthy()
    expect(
      parseProviderLoginOp({
        type: 'provider.login',
        provider: 'openai-codex',
        accountId: 'default',
      }),
    ).toBeNull()
    expect(
      parseProviderLoginOp({
        type: 'provider.login',
        provider: 'claude',
        accountId: 'default',
        addAccount: true,
      }),
    ).toBeNull()
    expect(
      parseProviderLoginOp({
        type: 'provider.login',
        provider: 'claude',
        credentialDir: '/private',
      }),
    ).toBeNull()
    const op = { type: 'claude.account', accountId: 'default' }
    expect(
      parseClientFrame(
        JSON.stringify({
          type: 'command',
          requestId: 'd8736746-ea12-452b-a492-411a74fba4f8',
          laneId: 'd8736746-ea12-452b-a492-411a74fba4f9',
          fence: 1,
          op,
        }),
      ).ok,
    ).toBe(true)
    expect(
      parseClientFrame(
        JSON.stringify({ type: 'command', requestId: 'd8736746-ea12-452b-a492-411a74fba4f8', op }),
      ).ok,
    ).toBe(false)
  })
  it('never reads credential-bearing npm sources back to the renderer', () => {
    const result = parseMachineSettings({
      section: 'resources',
      revision,
      resources: {
        packages: [
          {
            spec: 'npm:https://user:PRIVATE_TOKEN@example.test/package.tgz',
            name: 'package',
            scope: 'global',
            installed: true,
          },
        ],
      },
    })
    expect(result?.resources?.packages[0]?.spec).toBe('Source managed on Host')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN')
  })

  it('projects reviewed response fields, not secrets or raw configuration', () => {
    const result = parseMachineSettings({
      section: 'connectors',
      revision,
      connectors: {
        trusted: null,
        malformed: false,
        legacy: false,
        checkedAt: 10,
        servers: [
          {
            name: 'github',
            scope: 'global',
            transport: 'https',
            enabled: true,
            exposure: 'codemode',
            state: 'connected',
            tools: 12,
            headers: { Authorization: 'secret' },
            env: { TOKEN: 'private' },
            url: 'https://private',
          },
        ],
      },
      secret: 'credential',
    })
    expect(result?.connectors?.servers[0]).toMatchObject({ state: 'connected', tools: 12 })
    expect(JSON.stringify(result)).not.toMatch(/secret|credential|Authorization|private/)
    expect(
      parseMachineSettings({
        section: 'agent',
        revision,
        agent: { contextBudget: '200k', autoNameLanes: true, defaultThinkingLevel: 'invented' },
      }),
    ).toBeNull()
  })
})
