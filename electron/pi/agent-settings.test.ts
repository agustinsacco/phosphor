import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAgentSettings,
  listCatalogueModels,
  patchAgentSettings,
  patchWebSearchConfig,
  readAgentSettings,
  readAgentSettingsScoped,
  readWebSearchConfig,
} from './agent-settings'

/**
 * Regression guard: a malformed settings.json must never be overwritten by a
 * patch. Merging onto a failed parse silently dropped every existing key
 * (defaultProvider, defaultModel, packages[], …).
 */
describe('pi agent settings', () => {
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

  it('creates a fresh file when none exists', async () => {
    await patchAgentSettings('global', undefined, { defaultThinkingLevel: 'high' })
    const written = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(written).toEqual({ defaultThinkingLevel: 'high' })
  })

  it('merges into existing settings without dropping unrelated keys', async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({
        defaultProvider: 'local-stark',
        defaultModel: 'Qwen 3.5 122b',
        packages: ['pi-web-access'],
      }),
    )
    await patchAgentSettings('global', undefined, { hideThinkingBlock: true })
    const written = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(written).toEqual({
      defaultProvider: 'local-stark',
      defaultModel: 'Qwen 3.5 122b',
      packages: ['pi-web-access'],
      hideThinkingBlock: true,
    })
  })

  it('merges nested compaction/retry one level deep', async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ compaction: { enabled: true, reserveTokens: 50000 } }),
    )
    await patchAgentSettings('global', undefined, { compaction: { keepRecentTokens: 20000 } })
    const written = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(written.compaction).toEqual({
      enabled: true,
      reserveTokens: 50000,
      keepRecentTokens: 20000,
    })
  })

  it('REFUSES to write when the existing file is malformed, leaving it untouched', async () => {
    // Exactly the shape of the real-world breakage: a stray character.
    const broken =
      '{\n  "defaultProvider": "local-stark",\n  "compaction": { "enabled": true,y }\n}'
    await writeFile(settingsPath(), broken)

    await expect(
      patchAgentSettings('global', undefined, { hideThinkingBlock: true }),
    ).rejects.toThrow(/not valid JSON/)

    // The user's file survives byte-for-byte.
    expect(await readFile(settingsPath(), 'utf8')).toBe(broken)
  })

  it('reports malformed state so the UI can block editing', async () => {
    await writeFile(settingsPath(), '{ "oops": true,, }')
    const health = await checkAgentSettings()
    expect(health.global.exists).toBe(true)
    expect(health.global.malformed).toBe(true)
    expect(health.global.error).toBeTruthy()
  })

  it('reports a missing file as absent but not malformed', async () => {
    const health = await checkAgentSettings()
    expect(health.global).toMatchObject({ exists: false, malformed: false })
  })

  it('treats an empty file as writable, not malformed', async () => {
    await writeFile(settingsPath(), '   \n')
    const health = await checkAgentSettings()
    expect(health.global.malformed).toBe(false)
    await patchAgentSettings('global', undefined, { theme: 'dark' })
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('still degrades to empty settings for display when malformed', async () => {
    await writeFile(settingsPath(), '{ broken')
    await expect(readAgentSettings()).resolves.toEqual({})
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
      // pi's documented example: the project override keeps compaction.enabled.
      await expect(readAgentSettings(workspace)).resolves.toEqual({
        theme: 'dark',
        compaction: { enabled: true, reserveTokens: 8192 },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('web-search config lives under PI_CODING_AGENT_DIR when set, and patches merge', async () => {
    // The suite's beforeEach points PI_CODING_AGENT_DIR at the temp dir, which
    // is also pi-web-access's highest-precedence config location.
    const expectedPath = join(dir, 'web-search.json')

    const empty = await readWebSearchConfig()
    expect(empty).toMatchObject({ path: expectedPath, exists: false, malformed: false, config: {} })

    await patchWebSearchConfig({ braveApiKey: 'BSA_x', tavilyApiKey: 'tvly_y' })
    await patchWebSearchConfig({ tavilyApiKey: undefined, exaApiKey: '$EXA_API_KEY' })

    const read = await readWebSearchConfig()
    expect(read.exists).toBe(true)
    // undefined clears a key; other keys survive the merge.
    expect(read.config).toEqual({ braveApiKey: 'BSA_x', exaApiKey: '$EXA_API_KEY' })
  })

  it('web-search patch refuses to clobber a malformed file', async () => {
    const path = join(dir, 'web-search.json')
    await writeFile(path, '{ not json')
    await expect(patchWebSearchConfig({ braveApiKey: 'x' })).rejects.toThrow(/not valid JSON/)
    expect(await readFile(path, 'utf8')).toBe('{ not json')
    expect((await readWebSearchConfig()).malformed).toBe(true)
  })

  it('scoped read returns each file as written, never merged', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'phosphor-ws-'))
    try {
      await writeFile(settingsPath(), JSON.stringify({ defaultModel: 'claude-opus-5' }))
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(workspace, '.pi'), { recursive: true })
      await writeFile(
        join(workspace, '.pi', 'settings.json'),
        JSON.stringify({ defaultThinkingLevel: 'high' }),
      )
      await expect(readAgentSettingsScoped(workspace)).resolves.toEqual({
        global: { defaultModel: 'claude-opus-5' },
        project: { defaultThinkingLevel: 'high' },
      })
      // No workspace → project side is null, not {}.
      await expect(readAgentSettingsScoped()).resolves.toEqual({
        global: { defaultModel: 'claude-opus-5' },
        project: null,
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('project scope writes <workspace>/.pi/settings.json', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'phosphor-ws-'))
    try {
      await patchAgentSettings('project', workspace, { defaultModel: 'project-model' })
      const written = JSON.parse(await readFile(join(workspace, '.pi', 'settings.json'), 'utf8'))
      expect(written).toEqual({ defaultModel: 'project-model' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  /**
   * The home screen's picker has no live pi process to ask, so it reads
   * models.json directly. Shape verified against a real local install.
   */
  describe('catalogue models', () => {
    const modelsPath = (): string => join(dir, 'models.json')

    it('flattens providers into a model list', async () => {
      await writeFile(
        modelsPath(),
        JSON.stringify({
          providers: {
            'local-stark': {
              baseUrl: 'http://stark:8086/v1',
              compat: { supportsReasoningEffort: false },
              models: [{ id: 'Qwen 3.5 122b', name: 'Qwen 3.5 122b', contextWindow: 128000 }],
            },
            other: { models: [{ id: 'm-1' }] },
          },
        }),
      )

      const models = await listCatalogueModels()
      expect(models).toEqual([
        { id: 'Qwen 3.5 122b', name: 'Qwen 3.5 122b', provider: 'local-stark', reasoning: false },
        // No name key → falls back to the id; no compat → reasoning defaults on.
        { id: 'm-1', name: 'm-1', provider: 'other', reasoning: true },
      ])
    })

    it('returns nothing when models.json is absent or malformed', async () => {
      await expect(listCatalogueModels()).resolves.toEqual([])
      await writeFile(modelsPath(), '{ broken')
      await expect(listCatalogueModels()).resolves.toEqual([])
    })

    it('skips entries that are not usable models', async () => {
      await writeFile(
        modelsPath(),
        JSON.stringify({
          providers: {
            a: { models: 'not-an-array' },
            b: { models: [{ name: 'no id' }, null, { id: '' }, { id: 'good' }] },
            c: null,
          },
        }),
      )
      expect(await listCatalogueModels()).toEqual([
        { id: 'good', name: 'good', provider: 'b', reasoning: true },
      ])
    })
  })
})
