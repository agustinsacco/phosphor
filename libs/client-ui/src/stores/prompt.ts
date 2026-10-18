import { create } from 'zustand'

/**
 * App-owned replacement for `window.prompt`, which Electron does not
 * implement — it overrides the global to throw `prompt() is not supported.`
 * (electron/lib/renderer/window-setup.ts), so every rename/create flow that
 * called it died before a dialog ever appeared.
 *
 * `promptText` / `presentText` are callable from anywhere (context-menu
 * actions included, which live outside the React tree); `PromptHost` in
 * src/components renders the queue. Cancellation resolves `undefined`, the
 * same shape native prompt's `null` had at the call sites.
 */

export interface PromptOptions {
  title: string
  /** Guidance line under the title, for the cases that need one. */
  message?: string
  placeholder?: string
  initialValue?: string
  submitLabel?: string
  /**
   * Native prompt returns '' on an empty submit and some flows mean it
   * (blank compaction instructions, clearing a tree label). Without this
   * flag an empty submit resolves `undefined`, like a cancel.
   */
  allowEmpty?: boolean
}

export interface PromptRequest extends PromptOptions {
  id: number
  kind: 'input' | 'display' | 'choice'
  choices?: readonly { value: string; label: string; primary?: boolean }[]
  /** Display dialogs show this read-only instead of an input. */
  text?: string
  resolve: (value: string | undefined) => void
}

interface PromptState {
  /** FIFO, like the extension dialog queue; only the head renders. */
  requests: PromptRequest[]
  dismiss: (request: PromptRequest, value: string | undefined) => void
}

let promptId = 1

export const usePromptStore = create<PromptState>((set) => ({
  requests: [],
  dismiss: (request, value) => {
    set((s) => ({ requests: s.requests.filter((r) => r !== request) }))
    request.resolve(value)
  },
}))

function enqueue(request: Omit<PromptRequest, 'id' | 'resolve'>): Promise<string | undefined> {
  return new Promise((resolve) => {
    usePromptStore.setState((s) => ({
      requests: [...s.requests, { ...request, id: promptId++, resolve }],
    }))
  })
}

/** Ask for a line of text. Resolves `undefined` when cancelled. */
export function promptText(options: PromptOptions): Promise<string | undefined> {
  return enqueue({ ...options, kind: 'input' })
}

/** Ask for an explicit choice. Escape, backdrop and Cancel resolve undefined. */
export function promptChoice<T extends string>(options: {
  title: string
  message?: string
  choices: readonly { value: T; label: string; primary?: boolean }[]
}): Promise<T | undefined> {
  return enqueue({ ...options, kind: 'choice' }) as Promise<T | undefined>
}

/** Show selectable text the clipboard was denied (the old prompt fallback). */
export async function presentText(options: { title: string; text: string }): Promise<void> {
  await enqueue({ title: options.title, text: options.text, kind: 'display' })
}

/** Cancel suspended UI actions before another browser owner can answer them. */
export function cancelAllPrompts(): void {
  const requests = usePromptStore.getState().requests
  usePromptStore.setState({ requests: [] })
  for (const request of requests) request.resolve(undefined)
}
