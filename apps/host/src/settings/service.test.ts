import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { parseMachineSettings } from '@phosphor/shared/machine-settings-result'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import type {
  MachineSettingsChange,
  MachineSettingsSection,
} from '@phosphor/shared/machine-settings'
import { createHostClaudeAccounts } from '../providers/accounts'
import { createMachineSettings } from './service'
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: vi.fn() }))
const dirs: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'machine-settings-')))
  dirs.push(home)
  const agentDir = join(home, 'agent')
  const repo = join(home, 'project')
  const configPath = join(home, 'host.json')
  await mkdir(agentDir, { mode: 0o700 })
  await mkdir(repo, { mode: 0o700 })
  const config = {
    version: 1,
    pi: { executable: '/usr/bin/pi' },
    repositories: [repo],
    environment: { pass: ['TEST_SECRET'] },
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const repository = { id: '0123456789abcdef', path: repo, name: 'project' }
  const store = { getLane: () => null, listRepositories: () => [repository], listLanes: () => [] }
  const env = { HOME: home, PATH: '', PI_CODING_AGENT_DIR: agentDir }
  const accounts = createHostClaudeAccounts({ directory: join(home, 'state'), home, env })
  const settings = createMachineSettings({
    context: { store, home, env: { ...env, TEST_SECRET: 'private-value' }, log: () => {} },
    store,
    runtime: { accountForSession: () => undefined },
    configPath,
    env,
    accounts,
    pi: { binaryPath: '/usr/bin/pi', prefixArgs: [] },
    authenticating: () => false,
    sessionFor: () => null,
  })
  async function read(section: MachineSettingsSection, repositoryId?: string) {
    const result = await settings.feature.call(
      'machine.settings.read',
      { section, repositoryId },
      () => true,
    )
    if (!result.ok) throw new Error(result.error.message)
    const data = parseMachineSettings(result.data)
    if (!data) throw new Error('invalid result')
    return data
  }
  async function patch(
    section: MachineSettingsSection,
    change: MachineSettingsChange,
    revision: string,
    repositoryId?: string,
    allowed = () => true,
  ) {
    return settings.feature.call(
      'machine.settings.patch',
      { section, revision, repositoryId, change },
      allowed,
    )
  }
  return { home, agentDir, repo, configPath, config, settings, read, patch, repository, accounts }
}
describe('machine-owned settings service', () => {
  it('shows saved but inactive folder defaults without pretending the folder is trusted', async () => {
    const f = await fixture()
    await mkdir(join(f.repo, '.pi'))
    await writeFile(
      join(f.repo, '.pi/settings.json'),
      JSON.stringify({ defaultProvider: 'pi-claude-cli', defaultModel: 'saved-model' }),
      { mode: 0o600 },
    )
    const saved = await f.read('agent', f.repository.id)
    expect(saved.projectTrusted).toBe(false)
    expect(saved.agent).toMatchObject({
      defaultProvider: 'pi-claude-cli',
      defaultModel: 'saved-model',
    })
  })
  it('hides existing npm URL credentials at the Host boundary, before wire projection', async () => {
    const f = await fixture()
    await writeFile(
      join(f.agentDir, 'settings.json'),
      JSON.stringify({
        packages: [
          'npm:https://user:PRIVATE_TOKEN@example.test/package.tgz',
          'npm:safe-package@1.2.3',
        ],
      }),
      { mode: 0o600 },
    )
    const snapshot = await f.settings.snapshot('resources')
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_TOKEN')
    expect(snapshot.resources?.packages.map((package_) => package_.spec)).toEqual([
      'Source managed on Host',
      'npm:safe-package@1.2.3',
    ])
  })
  it('requires explicit configuration authority and admitted folder identity', async () => {
    const f = await fixture()
    expect((await f.settings.feature.call('machine.settings.read', { section: 'agent' })).ok).toBe(
      false,
    )
    expect(
      (
        await f.settings.feature.call(
          'machine.settings.read',
          { section: 'agent', repositoryId: 'ffffffffffffffff' },
          () => true,
        )
      ).ok,
    ).toBe(false)
    await rm(f.repo, { recursive: true })
    await symlink(f.home, f.repo)
    expect(
      (
        await f.settings.feature.call(
          'machine.settings.read',
          { section: 'agent', repositoryId: f.repository.id },
          () => true,
        )
      ).ok,
    ).toBe(false)
  })
  it('preserves unrelated pi settings and rejects simultaneous stale saves', async () => {
    const f = await fixture()
    const path = join(f.agentDir, 'settings.json')
    await writeFile(path, JSON.stringify({ packages: ['npm:keep'], custom: { preserved: true } }), {
      mode: 0o600,
    })
    const before = await f.read('agent')
    const writes = await Promise.all(
      ['one', 'two'].map((defaultModel) =>
        f.patch(
          'agent',
          { type: 'agent.patch', patch: { defaultProvider: 'provider', defaultModel } },
          before.revision,
        ),
      ),
    )
    expect(writes.map((result) => result.ok)).toEqual([true, false])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      packages: ['npm:keep'],
      custom: { preserved: true },
      defaultProvider: 'provider',
      defaultModel: 'one',
    })
  })
  it('reads folder overrides without materializing inherited machine model or behavior', async () => {
    const f = await fixture()
    await writeFile(
      join(f.agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'machine-model',
        compaction: { enabled: false },
      }),
      { mode: 0o600 },
    )
    const folder = await f.read('agent', f.repository.id)
    expect(folder.agent).not.toHaveProperty('defaultModel')
    expect(folder.agent).not.toHaveProperty('compaction')
    const machine = await f.read('agent')
    expect(machine.agent).toMatchObject({
      defaultModel: 'machine-model',
      compaction: { enabled: false },
    })
  })
  it('edits reviewed agent behavior without erasing other nested settings or exposing them', async () => {
    const f = await fixture()
    const path = join(f.agentDir, 'settings.json')
    await writeFile(
      path,
      JSON.stringify({
        compaction: { enabled: true, model: 'keep-private', reserveTokens: 16384 },
        retry: { enabled: false, custom: 'keep' },
        packages: ['npm:keep'],
      }),
      { mode: 0o600 },
    )
    const before = await f.read('agent')
    expect(JSON.stringify(before)).not.toContain('keep-private')
    const result = await f.patch(
      'agent',
      {
        type: 'agent.patch',
        patch: {
          compaction: { enabled: false },
          retry: { maxRetries: 5 },
          steeringMode: 'all',
          hideThinkingBlock: true,
        },
      },
      before.revision,
    )
    expect(result.ok).toBe(true)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved).toMatchObject({
      compaction: { enabled: false, model: 'keep-private', reserveTokens: 16384 },
      retry: { enabled: false, custom: 'keep', maxRetries: 5 },
      packages: ['npm:keep'],
    })
    expect((await f.read('agent')).agent).toMatchObject({
      compaction: { enabled: false, reserveTokens: 16384 },
      retry: { enabled: false, maxRetries: 5 },
      steeringMode: 'all',
      hideThinkingBlock: true,
    })
  })
  it('rejects unreviewed behavior fields and malformed nested configuration rather than replacing it', async () => {
    const f = await fixture()
    const path = join(f.agentDir, 'settings.json')
    await writeFile(path, JSON.stringify({ compaction: 'malformed' }), { mode: 0o600 })
    const before = await f.read('agent')
    const result = await f.patch(
      'agent',
      { type: 'agent.patch', patch: { compaction: { enabled: false } } },
      before.revision,
    )
    expect(result.ok).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ compaction: 'malformed' })
  })
  it('saves Host policy separately without changing the running config or repository list', async () => {
    const f = await fixture()
    const before = await f.read('agent')
    expect(
      (
        await f.patch(
          'agent',
          { type: 'agent.patch', patch: { contextBudget: '100k', autoNameLanes: false } },
          before.revision,
        )
      ).ok,
    ).toBe(true)
    expect(JSON.parse(await readFile(f.configPath, 'utf8'))).toMatchObject({
      contextBudget: '100k',
      autoNameLanes: false,
      repositories: [f.repo],
    })
    expect(f.config).not.toHaveProperty('contextBudget')
    const next = await f.read('agent')
    expect(
      (
        await f.patch(
          'agent',
          { type: 'agent.patch', patch: { defaultModel: 'm', contextBudget: '200k' } },
          next.revision,
        )
      ).ok,
    ).toBe(false)
  })
  it('writes only the selected folder and does not approve project trust', async () => {
    const f = await fixture()
    const before = await f.read('agent', f.repository.id)
    expect(before.projectTrusted).toBe(false)
    expect(
      (
        await f.patch(
          'agent',
          {
            type: 'agent.patch',
            patch: { defaultModel: 'folder-model', defaultProvider: 'provider' },
          },
          before.revision,
          f.repository.id,
        )
      ).ok,
    ).toBe(true)
    expect(
      JSON.parse(await readFile(join(f.repo, '.pi', 'settings.json'), 'utf8')).defaultModel,
    ).toBe('folder-model')
    expect((await f.read('agent', f.repository.id)).agent?.defaultModel).toBe('folder-model')
    expect((await readAgentSettings(f.repo, f.agentDir)).defaultModel).toBeUndefined()
    await expect(readFile(join(f.agentDir, 'settings.json'))).rejects.toThrow()
    await expect(readFile(join(f.agentDir, 'trust.json'))).rejects.toThrow()
  })
  it('keeps connector credentials on the Host and never reads them back', async () => {
    const f = await fixture()
    const before = await f.read('connectors')
    const changed = await f.patch(
      'connectors',
      {
        type: 'mcp.upsert',
        name: 'private',
        config: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer SECRET-VALUE' },
        },
      },
      before.revision,
    )
    expect(changed.ok).toBe(true)
    expect(JSON.stringify(changed)).not.toContain('SECRET-VALUE')
    expect(await readFile(join(f.agentDir, 'mcp.json'), 'utf8')).toContain('SECRET-VALUE')
    const current = await f.read('connectors')
    expect(
      (
        await f.patch(
          'connectors',
          { type: 'mcp.upsert', name: 'private', config: { url: 'https://replacement.example' } },
          current.revision,
        )
      ).ok,
    ).toBe(false)
    expect(
      (
        await f.patch(
          'connectors',
          { type: 'mcp.enabled', name: 'missing', enabled: true },
          current.revision,
        )
      ).ok,
    ).toBe(false)
    expect(
      (
        await f.patch(
          'connectors',
          { type: 'mcp.enabled', name: 'private', enabled: false },
          current.revision,
        )
      ).ok,
    ).toBe(true)
    expect(await readFile(join(f.agentDir, 'mcp.json'), 'utf8')).toContain('SECRET-VALUE')
  })
  it('verifies connector status through pi, discards sensitive fields, and invalidates stale checks', async () => {
    const f = await fixture()
    const before = await f.read('connectors')
    await f.patch(
      'connectors',
      { type: 'mcp.upsert', name: 'tools', config: { url: 'https://example.com' } },
      before.revision,
    )
    vi.mocked(runPrintMode).mockResolvedValue({
      stdout: JSON.stringify({
        servers: [
          { name: 'tools', state: 'connected', tools: [{ name: 'tool' }], token: 'PRIVATE' },
        ],
      }),
    })
    const result = await f.settings.feature.call(
      'machine.settings.check',
      { section: 'connectors' },
      () => true,
    )
    expect(result.ok && parseMachineSettings(result.data)?.connectors?.servers[0]).toMatchObject({
      state: 'connected',
      tools: 1,
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    const current = await f.read('connectors')
    await f.patch(
      'connectors',
      { type: 'mcp.enabled', name: 'tools', enabled: false },
      current.revision,
    )
    expect((await f.read('connectors')).connectors?.checkedAt).toBeUndefined()
    expect(vi.mocked(runPrintMode).mock.calls[0]?.[2]?.env).toMatchObject({
      HOME: f.home,
      PI_CODING_AGENT_DIR: f.agentDir,
    })
  })
  it.each(['authentication', 'files', 'revocation'])(
    'does not cache a check overtaken by %s changes',
    async (change) => {
      const f = await fixture()
      let allowed = true
      vi.mocked(runPrintMode).mockImplementation(async () => {
        if (change === 'authentication') f.settings.invalidateConnectors()
        if (change === 'files')
          await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ theme: 'changed' }), {
            mode: 0o600,
          })
        if (change === 'revocation') allowed = false
        return { stdout: JSON.stringify({ servers: [] }) }
      })
      const result = await f.settings.feature.call(
        'machine.settings.check',
        { section: 'connectors' },
        () => allowed,
      )
      expect(result.ok).toBe(false)
      expect((await f.read('connectors')).connectors?.checkedAt).toBeUndefined()
    },
  )
  it('retains metadata authorization across asynchronous provider mutations', async () => {
    const f = await fixture()
    const path = join(f.home, 'state/claude-accounts/accounts.json')
    const prefs = {
      ...DEFAULT_CLAUDE_ACCOUNT_PREFS,
      accounts: [{ id: 'default', label: 'Host account', credentialDir: null, addedAt: 1 }],
    }
    await writeFile(path, JSON.stringify(prefs), { mode: 0o600 })
    const before = await f.read('providers')
    expect(before.providers?.accounts[0]).toMatchObject({ id: 'default', label: 'Host account' })
    expect(JSON.stringify(before)).not.toContain('credentialDir')
    let allowed = true
    const setRouting = f.accounts.setRouting
    vi.spyOn(f.accounts, 'setRouting').mockImplementation(async (mode, pinnedId) => {
      await Promise.resolve()
      allowed = false
      await setRouting(mode, pinnedId)
    })
    const result = await f.patch(
      'providers',
      { type: 'claude.routing', mode: 'ordered' },
      before.revision,
      undefined,
      () => allowed,
    )
    expect(result.ok).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(prefs)
  })
  it('serializes section calls, bounds the queue, and rechecks queued authority', async () => {
    const f = await fixture()
    let release!: () => void
    let started!: () => void
    const checking = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.mocked(runPrintMode).mockImplementation(async () => {
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { stdout: JSON.stringify({ servers: [] }) }
    })
    const first = f.settings.feature.call(
      'machine.settings.check',
      { section: 'connectors' },
      () => true,
    )
    await checking
    let allowed = true
    const queued = Array.from({ length: 7 }, () =>
      f.settings.feature.call('machine.settings.read', { section: 'agent' }, () => allowed),
    )
    const full = await f.settings.feature.call(
      'machine.settings.read',
      { section: 'agent' },
      () => true,
    )
    expect(full).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Settings are busy. Try again.' },
    })
    allowed = false
    release()
    expect((await first).ok).toBe(true)
    for (const result of await Promise.all(queued))
      expect(result).toEqual({
        ok: false,
        error: { code: 'forbidden', message: 'Configuration access was revoked.' },
      })
    expect((await f.read('agent')).section).toBe('agent')
  })
  it('expires shared connector status after sixty seconds without running another check', async () => {
    const f = await fixture()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.mocked(runPrintMode).mockResolvedValue({ stdout: JSON.stringify({ servers: [] }) })
    try {
      const result = await f.settings.feature.call(
        'machine.settings.check',
        { section: 'connectors' },
        () => true,
      )
      expect(result.ok).toBe(true)
      now.mockReturnValue(60_999)
      expect((await f.read('connectors')).connectors?.checkedAt).toBe(1000)
      now.mockReturnValue(61_000)
      expect((await f.read('connectors')).connectors?.checkedAt).toBeUndefined()
      expect(runPrintMode).toHaveBeenCalledOnce()
    } finally {
      now.mockRestore()
    }
  })
  it('returns names and availability only for environment diagnostics', async () => {
    const f = await fixture()
    const data = await f.read('advanced')
    expect(data.advanced?.environment).toEqual([
      { name: 'TEST_SECRET', available: true, passed: false },
    ])
    expect(JSON.stringify(data)).not.toContain('private-value')
  })
  it('rechecks authority during async file commits', async () => {
    const f = await fixture()
    const before = await f.read('agent')
    let calls = 0
    const outcome = await f.patch(
      'agent',
      { type: 'agent.patch', patch: { defaultModel: 'denied' } },
      before.revision,
      undefined,
      () => ++calls < 4,
    )
    expect(outcome.ok).toBe(false)
    await expect(readFile(join(f.agentDir, 'settings.json'))).rejects.toThrow()
  })
})
