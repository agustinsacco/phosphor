import type { BrainSearch } from '@phosphor/memory-engine/types'
import { SEARCH_METHODS, type FromSearchWorker, type ToSearchWorker } from './search-protocol'

export interface SearchWorkerOptions {
  post(message: FromSearchWorker): void
  /** Opens the read-only search over the Brain database. */
  open(path: string): BrainSearch
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The search process's side: one read-only connection and its in-memory vector index, answering
 * main's calls in order. Messages arrive in the order main sent them, so a call made right after
 * `open` runs after it; a failed open answers every call with the reason instead.
 */
export function createSearchWorkerHandler(
  options: SearchWorkerOptions,
): (input: ToSearchWorker) => void {
  let search: BrainSearch | null = null
  let failure = 'Brain search is not open.'
  return (input) => {
    if (input.type === 'open') {
      search?.close()
      search = null
      try {
        search = options.open(input.path)
      } catch (error) {
        failure = `Brain search could not open: ${message(error)}`
      }
      return
    }
    if (input.type === 'close') {
      search?.close()
      search = null
      failure = 'Brain search is closed.'
      return
    }
    const { id, method, args } = input
    if (!search) return options.post({ type: 'error', id, error: failure })
    if (!(SEARCH_METHODS as readonly string[]).includes(method))
      return options.post({ type: 'error', id, error: 'Unknown Brain search method.' })
    try {
      const call = search[method] as (...values: unknown[]) => unknown
      options.post({ type: 'result', id, value: call.apply(search, args) })
    } catch (error) {
      options.post({ type: 'error', id, error: message(error) })
    }
  }
}
