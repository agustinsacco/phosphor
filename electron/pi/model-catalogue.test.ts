import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PiRpcClient } from './rpc-client'
import {
  requestAvailableModels,
  resolveCatalogueModels,
  toCatalogueModels,
  type CatalogueModel,
} from './model-catalogue'
import type { Model } from '@shared/rpc'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const fakePi = join(fixtureDir, 'fake-pi.cjs')

const clients: PiRpcClient[] = []
function makeFakeClient(env?: Record<string, string>): PiRpcClient {
  const client = new PiRpcClient({
    cwd: fixtureDir,
    binaryPath: process.execPath,
    prefixArgs: [fakePi],
    env,
  })
  clients.push(client)
  return client
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.dispose()))
})

describe('toCatalogueModels', () => {
  it('narrows the full RPC Model to what pickers need, keeping the level map', () => {
    const model: Model = {
      id: 'us.anthropic.claude-opus-5',
      name: 'Claude Opus 5 (US)',
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
    }
    expect(toCatalogueModels([model])).toEqual([
      {
        id: 'us.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (US)',
        provider: 'amazon-bedrock',
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
      },
    ])
  })

  it('omits metadata the catalogue did not supply, rather than defaulting it', () => {
    // The models.json fallback knows an id, a name and a provider. A zero
    // context window or a $0 price would render as fact in the picker.
    const sparse = {
      id: 'my-model',
      name: 'My Model',
      provider: 'local-thing',
      reasoning: false,
    } as unknown as Model
    expect(toCatalogueModels([sparse])[0]).toEqual({
      id: 'my-model',
      name: 'My Model',
      provider: 'local-thing',
      reasoning: false,
      thinkingLevelMap: undefined,
    })
  })

  it('does not forward unknown fields pi may add to Model', () => {
    // `Model` carries an index signature; a passthrough would ship whatever
    // pi adds next straight into the renderer.
    const extra = {
      id: 'm',
      name: 'M',
      provider: 'p',
      reasoning: false,
      secretInternalField: 'nope',
    } as unknown as Model
    expect(toCatalogueModels([extra])[0]).not.toHaveProperty('secretInternalField')
  })
})

describe('requestAvailableModels', () => {
  it('returns the fixture catalogue with real display names, not ids', async () => {
    const client = makeFakeClient()
    client.spawn()
    const models = await requestAvailableModels(client)
    expect(models.map((m) => ({ id: m.id, name: m.name }))).toEqual([
      { id: 'us.anthropic.claude-opus-5', name: 'Claude Opus 5 (US)' },
      { id: 'Qwen 3.5 122b', name: 'Qwen 3.5 122b' },
    ])
    // The regression this design fixes: `pi --list-models` only ever prints
    // ids, so the home picker showed `us.anthropic.claude-opus-5` where a
    // live session showed "Claude Opus 5 (US)". The RPC carries the name.
    expect(models[0]?.name).not.toBe(models[0]?.id)
  })

  it('carries thinkingLevelMap so the home picker derives real levels', async () => {
    const client = makeFakeClient()
    client.spawn()
    const models = await requestAvailableModels(client)
    expect(models[0]?.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' })
    expect(models[1]?.thinkingLevelMap).toBeUndefined()
  })

  it('rejects when pi accepts the request but never answers', async () => {
    // FAKE_PI_HANG_MODELS simulates a genuine hang — the case the timeout
    // exists for, since a fast error already rejects on its own.
    const client = makeFakeClient({ FAKE_PI_HANG_MODELS: '1' })
    client.spawn()
    await expect(requestAvailableModels(client, 50)).rejects.toThrow(/timed out/)
  })
})

describe('resolveCatalogueModels', () => {
  const configModels: CatalogueModel[] = [
    { id: 'Qwen 3.5 122b', name: 'Qwen 3.5 122b', provider: 'local-stark', reasoning: false },
  ]

  it('uses the injected listModels function when a binary resolves', async () => {
    const rpcModels: CatalogueModel[] = [
      {
        id: 'us.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (US)',
        provider: 'amazon-bedrock',
        reasoning: true,
      },
    ]
    const result = await resolveCatalogueModels(
      async () => '/fake/pi',
      async () => configModels,
      async (binaryPath) => {
        expect(binaryPath).toBe('/fake/pi')
        return rpcModels
      },
    )
    expect(result).toEqual({ models: rpcModels, source: 'pi' })
  })

  it('falls back to config when listModels returns nothing', async () => {
    const result = await resolveCatalogueModels(
      async () => '/fake/pi',
      async () => configModels,
      async () => [],
    )
    expect(result).toEqual({ models: configModels, source: 'config' })
  })

  it('falls back to config when no pi binary is found', async () => {
    const result = await resolveCatalogueModels(
      async () => null,
      async () => configModels,
      async () => {
        throw new Error('should not be called without a binary')
      },
    )
    expect(result).toEqual({ models: configModels, source: 'config' })
  })

  it('falls back to config when listModels throws', async () => {
    const result = await resolveCatalogueModels(
      async () => '/fake/pi',
      async () => configModels,
      async () => {
        throw new Error('RPC exploded')
      },
    )
    expect(result).toEqual({ models: configModels, source: 'config' })
  })

  it('falls back to config when resolving the binary throws', async () => {
    const result = await resolveCatalogueModels(
      async () => {
        throw new Error('health check exploded')
      },
      async () => configModels,
    )
    expect(result).toEqual({ models: configModels, source: 'config' })
  })

  it('marks an empty config fallback as a fallback, not as pi answering', async () => {
    const result = await resolveCatalogueModels(
      async () => null,
      async () => [],
    )
    expect(result).toEqual({ models: [], source: 'config' })
  })
})
