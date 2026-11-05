import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchWebSearchConfig, readWebSearchConfig, writeConfigFile } from './agent-settings'

/** web-search.json holds API keys: the renderer learns which are set, never their values. */
describe('web access keys stay in main and on disk 0600', () => {
  let dir: string
  let previousEnv: string | undefined
  const path = (): string => join(dir, 'web-search.json')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-web-access-'))
    previousEnv = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
  })

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousEnv
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the names of configured keys, never their values', async () => {
    await writeFile(
      path(),
      JSON.stringify({ braveApiKey: 'BSA_SECRET', exaApiKey: '', searxngUrl: 'https://s.test' }),
    )
    const read = await readWebSearchConfig()
    expect(read).toEqual({
      path: path(),
      exists: true,
      malformed: false,
      configured: ['braveApiKey'],
    })
    expect(JSON.stringify(read)).not.toContain('BSA_SECRET')
  })

  it('patches values in and writes the file 0600, chmodding one that exists', async () => {
    await writeFile(path(), '{"kagiApiKey":"k"}')
    await chmod(path(), 0o644)
    await patchWebSearchConfig({ braveApiKey: 'BSA_x' })
    expect((await stat(path())).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      kagiApiKey: 'k',
      braveApiKey: 'BSA_x',
    })
    expect((await readWebSearchConfig()).configured).toEqual(['braveApiKey', 'kagiApiKey'])
  })

  it('writes the raw editor’s web-search.json 0600 too', async () => {
    await writeFile(path(), '{}')
    await chmod(path(), 0o664)
    await writeConfigFile('web-search', '{ "tavilyApiKey": "tvly" }\n')
    expect((await stat(path())).mode & 0o777).toBe(0o600)
    await writeConfigFile('settings', '{}\n')
    expect((await stat(join(dir, 'settings.json'))).mode & 0o777).not.toBe(0o600)
  })
})
