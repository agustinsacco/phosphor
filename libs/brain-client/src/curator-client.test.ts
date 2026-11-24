import { describe, expect, it, vi } from 'vitest'
import type { BrainTransport } from './port'
import { BRAIN_CURATOR_TIMEOUTS, createBrainCuratorClient } from './curator-client'
import { OWNERSHIP_DETAIL, RINA_SUGGESTION, RINA_VIEW, WAITING } from './__fixtures__/curator'
import { HARBOR_RECALL } from './__fixtures__/recall'

function setup(result: unknown) {
  const request = vi.fn<BrainTransport['request']>().mockResolvedValue(result as never)
  return { request, client: createBrainCuratorClient({ request }) }
}
const done = { status: 'done', message: 'Merged Rina into Rina Okafor.', operationId: 'op-1' }

describe('createBrainCuratorClient', () => {
  it('sends validated requests and returns well-formed results', async () => {
    const cases = [
      ['waiting', {}, WAITING],
      ['suggestion', { suggestionId: 'sugg-rina' }, RINA_SUGGESTION],
      ['suggestion', { suggestionId: 'gone' }, null],
      ['entity', { entityId: 'rina' }, RINA_VIEW],
      ['memory', { memoryId: 'ownership' }, OWNERSHIP_DETAIL],
      ['search', { query: 'Harbor' }, HARBOR_RECALL],
      ['erase', { memoryId: 'ownership', reason: 'Superseded by KES-12.' }, done],
    ] as const
    for (const [method, request, result] of cases) {
      const { client, request: send } = setup(result)
      expect(await client.call(method, request as never)).toEqual(result)
      expect(send).toHaveBeenCalledWith(method, request, expect.any(AbortSignal))
    }
  })

  it('refuses invalid requests before sending, naming the problem', async () => {
    const { client, request } = setup(done)
    await expect(client.call('erase', { memoryId: 'ownership', reason: '' })).rejects.toMatchObject(
      { code: 'malformed', message: 'Brain reason needs 1 to 300 characters.' },
    )
    await expect(client.call('search', { query: '' })).rejects.toMatchObject({ code: 'malformed' })
    expect(request).not.toHaveBeenCalled()
  })

  it('sends the trimmed reason', async () => {
    const { client, request } = setup(done)
    await client.call('undo', { operationId: 'op-1', reason: '  Wrong merge.  ' })
    expect(request.mock.calls[0]![1]).toEqual({ operationId: 'op-1', reason: 'Wrong merge.' })
  })

  it.each([
    ['waiting', { ...WAITING, more: -1 }],
    ['waiting', { ...WAITING, items: [{ kind: 'read' }] }],
    ['suggestion', { ...RINA_SUGGESTION, allowed: 'merge' }],
    ['entity', { ...RINA_VIEW, entity: { id: 'rina' } }],
    ['memory', { ...OWNERSHIP_DETAIL, memory: { id: 'x' } }],
    ['erase', { ...done, extra: true }],
    ['erase', { ...done, status: 'maybe' }],
    ['erase', undefined],
  ] as const)('rejects a malformed %s result', async (method, result) => {
    const request =
      method === 'waiting'
        ? {}
        : method === 'erase'
          ? { memoryId: 'ownership', reason: 'Superseded.' }
          : method === 'suggestion'
            ? { suggestionId: 's' }
            : method === 'entity'
              ? { entityId: 'rina' }
              : { memoryId: 'ownership' }
    await expect(setup(result).client.call(method, request as never)).rejects.toMatchObject({
      code: 'malformed',
    })
  })

  it('gives refresh calls the long deadline and the caller can still cancel', async () => {
    expect(BRAIN_CURATOR_TIMEOUTS.waiting).toBeLessThan(60_000)
    const signals: AbortSignal[] = []
    const request = vi.fn<BrainTransport['request']>(
      (_m, _p, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal!)
          signal!.addEventListener('abort', () => reject(signal!.reason as Error))
        }),
    )
    const client = createBrainCuratorClient(
      { request },
      { ...BRAIN_CURATOR_TIMEOUTS, waiting: 20, entity: 60_000 },
    )
    await expect(client.call('waiting', {})).rejects.toMatchObject({ name: 'TimeoutError' })

    const controller = new AbortController()
    const review = client.call('entity', { entityId: 'rina' }, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signals[1]!.aborted).toBe(false)
    controller.abort()
    await expect(review).rejects.toMatchObject({ name: 'AbortError' })
    expect(signals[1]!.aborted).toBe(true)
  })
})
