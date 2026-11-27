import type { ExtensionUIRequest, ExtensionUIResponse } from '@phosphor/shared/rpc'

/** The questions pi waits on; the page shape keeps 16. */
const ASKED = new Set<ExtensionUIRequest['method']>(['select', 'confirm', 'input', 'editor'])
const SHOWN = 16

export interface OpenDialog<Asker> {
  readonly request: ExtensionUIRequest
  /** Who asked: the process and turn the question came from. */
  readonly asker: Asker
  timer?: NodeJS.Timeout
}

/**
 * Brain Agent's open questions, each kept with who asked it. A question leaves when it is
 * answered, pi's own timeout ends it, or the lane exits or restarts; none is answered here.
 */
export function createConversationDialogs<Asker>() {
  const open = new Map<string, OpenDialog<Asker>>()
  const close = (id: string) => {
    clearTimeout(open.get(id)?.timer)
    open.delete(id)
  }
  return {
    open(request: ExtensionUIRequest, asker: Asker) {
      if (!ASKED.has(request.method)) return
      close(request.id)
      const timeout = 'timeout' in request ? request.timeout : undefined
      const timer =
        typeof timeout === 'number' && timeout > 0
          ? setTimeout(() => open.delete(request.id), Math.min(timeout, 2 ** 31 - 1))
          : undefined
      timer?.unref()
      open.set(request.id, { request, asker, ...(timer ? { timer } : {}) })
    },
    get: (id: string): OpenDialog<Asker> | undefined => open.get(id),
    close,
    clear() {
      for (const id of [...open.keys()]) close(id)
    },
    /** The newest questions `shown` admits. */
    list: (shown: (dialog: OpenDialog<Asker>) => boolean) =>
      [...open.values()]
        .filter(shown)
        .slice(-SHOWN)
        .map(({ request }) => request),
  }
}

/** An answer of the kind its question takes: a choice it offered, a yes/no, text, or cancel. */
export function dialogAnswerFits(asked: ExtensionUIRequest, answer: ExtensionUIResponse): boolean {
  if (answer.id !== asked.id) return false
  if ('cancelled' in answer) return answer.cancelled === true
  if (asked.method === 'confirm') return 'confirmed' in answer
  if (!('value' in answer) || typeof answer.value !== 'string') return false
  if (asked.method === 'select') return asked.options.includes(answer.value)
  return asked.method === 'input' || asked.method === 'editor'
}
