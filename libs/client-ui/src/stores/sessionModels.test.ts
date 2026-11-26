import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Model, RpcResponse, RpcResponseDataMap } from '@shared/rpc'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useChatStore } from './chat'
import { loadSessionModels } from './sessionModels'

type ModelsReply = RpcResponse<RpcResponseDataMap['get_available_models']>
const envelope = { type: 'response', command: 'get_available_models' } as const
const modelsReply = (list: Model[]): ModelsReply => ({
  ...envelope,
  success: true,
  data: { models: list },
})
function pendingReply() {
  let finish!: (reply: ModelsReply) => void
  const promise = new Promise<ModelsReply>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

const SESSION = 'lane'
const models: Model[] = [
  {
    provider: 'p',
    id: 'first',
    name: 'First model',
    api: 'p',
    reasoning: false,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
]
const readModels = vi.fn<() => Promise<ModelsReply>>()
const session = () => useChatStore.getState().sessions[SESSION]
let dispose: () => void

beforeEach(() => {
  readModels.mockReset()
  useChatStore.setState({ sessions: {} })
  const fake = createFakePhosphor({ 'pi:command': readModels })
  vi.stubGlobal('window', {})
  const restore = installFakePhosphor(fake)
  dispose = () => {
    restore()
    fake.dispose()
    vi.unstubAllGlobals()
  }
})
afterEach(() => dispose())

it('joins an in-flight bootstrap read on Retry, and permits a new read after settlement', async () => {
  useChatStore.getState().ensure(SESSION)
  useChatStore.getState().setModels(SESSION, models)
  const reply = pendingReply()
  readModels.mockReturnValueOnce(reply.promise).mockResolvedValue(modelsReply([]))

  const bootstrap = loadSessionModels(SESSION, () => true)
  const retry = loadSessionModels(SESSION, () => true)
  await Promise.resolve()
  expect(session()).toMatchObject({ modelsRefreshing: true, models })
  reply.finish({ ...envelope, success: false, error: 'pi not ready' })
  await Promise.all([bootstrap, retry])
  expect(readModels).toHaveBeenCalledOnce()
  expect(session()).toMatchObject({ modelsRefreshing: false, modelsFailed: true, models })

  await loadSessionModels(SESSION, () => true)
  expect(readModels).toHaveBeenCalledTimes(2)
  expect(session()).toMatchObject({ modelsRefreshing: false, modelsFailed: false, models: [] })
})

it('does not let a stale reply replace the models of a re-adopted lane', async () => {
  const stale = pendingReply()
  readModels.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(modelsReply([]))
  const chat = useChatStore.getState()
  chat.ensure(SESSION)
  const oldRead = loadSessionModels(SESSION, () => true)
  await Promise.resolve()

  chat.remove(SESSION)
  chat.ensure(SESSION)
  await loadSessionModels(SESSION, () => true)
  stale.finish(modelsReply(models))
  await oldRead
  expect(session()).toMatchObject({ models: [], modelsRefreshing: false })
})

it('does not recreate a closed lane’s chat slice or send another read', async () => {
  readModels.mockResolvedValue(modelsReply(models))
  await loadSessionModels(SESSION, () => false)
  expect(session()).toBeUndefined()
  expect(readModels).not.toHaveBeenCalled()
})
