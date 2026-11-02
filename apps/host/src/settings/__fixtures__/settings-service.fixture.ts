import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMachineSettings } from '@phosphor/shared/machine-settings-result'
import type {
  MachineSettingsChange,
  MachineSettingsSection,
} from '@phosphor/shared/machine-settings'
import { createHostClaudeAccounts } from '../../providers/accounts'
import { createMachineSettings } from '../service'
const dirs: string[] = []
/** Call from the suite's afterEach. */
export async function removeSettingsFixtures() {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}
/** A Host settings service over a temporary home, agent dir, registered folder and config. */
export async function settingsServiceFixture() {
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
    pi: { binaryPath: '/usr/bin/node', prefixArgs: ['/opt/pi/cli.js'], version: '1.2.0' },
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
