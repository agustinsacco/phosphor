import type { MemoryStorePort } from '@phosphor/memory-engine/ports'
import type { MemoryOperations, MemoryRequest, MemoryResponse } from './memory-protocol'
import { MEMORY_MAX_BYTES, MEMORY_METHODS } from './memory-protocol'

export function createMemoryHandler(
  store: MemoryStorePort,
): (request: MemoryRequest) => MemoryResponse {
  const operations: MemoryOperations = {
    ...store,
    captureAt(epoch, input) {
      const current = store.snapshot()
      if (current.policyEpoch !== epoch || !current.prefs.enabled) return null
      return store.capture(input)
    },
    commitVectors(revision, vectors) {
      const current = store.snapshot()
      if (
        !current.prefs.enabled ||
        current.policyEpoch !== revision.policyEpoch ||
        current.graphRevision !== revision.graphRevision
      )
        return false
      store.putVectors(vectors)
      return true
    },
  }
  return (request) => {
    try {
      if (
        !Number.isSafeInteger(request.id) ||
        !MEMORY_METHODS.includes(request.method) ||
        !Array.isArray(request.args) ||
        Buffer.byteLength(JSON.stringify(request)) > MEMORY_MAX_BYTES
      )
        throw new Error('Invalid Brain database request')
      if (
        request.method === 'createJob' &&
        (!Number.isSafeInteger(request.args[2]) || request.args[2]! < 0)
      )
        throw new Error('Manual processing requires an acknowledged policy epoch')
      // Discriminated requests retain their method-specific tuple on the sending side.
      const operation = operations[request.method] as (...args: unknown[]) => unknown
      const response: MemoryResponse = {
        id: request.id,
        ok: true,
        data: operation(...request.args),
      }
      if (Buffer.byteLength(JSON.stringify(response)) > MEMORY_MAX_BYTES)
        throw new Error('Brain database response exceeds limit')
      return response
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error:
          error instanceof Error ? error.message.slice(0, 8000) : 'Brain database operation failed',
      }
    }
  }
}
