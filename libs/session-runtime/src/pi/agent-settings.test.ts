import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentSettings } from './agent-settings'

describe('readAgentSettings', () => {
  let dir: string
  let previousEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-settings-'))
    previousEnv = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
  })

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousEnv
    await rm(dir, { recursive: true, force: true })
  })

  const settingsPath = (): string => join(dir, 'settings.json')

  it('still degrades to empty settings for display when malformed', async () => {
    await writeFile(settingsPath(), '{ broken')
    await expect(readAgentSettings()).resolves.toEqual({})
  })

  it.each(['null', '[]', '[1]', '"dark"', '42', 'true'])(
    'ignores a non-object project config (%s) without losing global settings',
    async (raw) => {
      const workspace = join(dir, 'workspace')
      await mkdir(join(workspace, '.pi'), { recursive: true })
      await writeFile(
        settingsPath(),
        JSON.stringify({ theme: 'dark', compaction: { enabled: true } }),
      )
      await writeFile(join(workspace, '.pi', 'settings.json'), raw)
      await expect(readAgentSettings(workspace)).resolves.toEqual({
        theme: 'dark',
        compaction: { enabled: true },
      })
    },
  )

  it('ignores untrusted provider overrides instead of billing the CLI default credential', async () => {
    const workspace = join(dir, 'workspace')
    await mkdir(join(workspace, '.pi'), { recursive: true })
    await writeFile(settingsPath(), JSON.stringify({ defaultProvider: 'pi-claude-cli' }))
    await writeFile(
      join(workspace, '.pi', 'settings.json'),
      JSON.stringify({ defaultProvider: 'native' }),
    )
    expect((await readAgentSettings(workspace)).defaultProvider).toBe('pi-claude-cli')
    await writeFile(join(dir, 'trust.json'), JSON.stringify({ [await realpath(workspace)]: true }))
    expect((await readAgentSettings(workspace)).defaultProvider).toBe('native')
  })

  it('uses the execution machine agent directory, not the ambient process directory', async () => {
    const host = join(dir, 'host-agent')
    await mkdir(host)
    await writeFile(settingsPath(), JSON.stringify({ defaultProvider: 'native' }))
    await writeFile(
      join(host, 'settings.json'),
      JSON.stringify({ defaultProvider: 'pi-claude-cli' }),
    )
    expect((await readAgentSettings(undefined, host)).defaultProvider).toBe('pi-claude-cli')
  })

  it('merges project overrides one level deep, matching pi semantics', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'phosphor-ws-'))
    try {
      await writeFile(
        settingsPath(),
        JSON.stringify({
          theme: 'dark',
          compaction: { enabled: true, reserveTokens: 16384 },
        }),
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(workspace, '.pi'), { recursive: true })
      await writeFile(
        join(workspace, '.pi', 'settings.json'),
        JSON.stringify({ compaction: { reserveTokens: 8192 } }),
      )
      await writeFile(
        join(dir, 'trust.json'),
        JSON.stringify({ [await realpath(workspace)]: true }),
      )
      // pi's documented example: the project override keeps compaction.enabled.
      await expect(readAgentSettings(workspace)).resolves.toEqual({
        theme: 'dark',
        compaction: { enabled: true, reserveTokens: 8192 },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
