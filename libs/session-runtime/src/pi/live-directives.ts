import type { PiRpcClient } from './rpc-client'

/** A single pi process, its actual spawn-time base, and the facts used to compose it. */
export function createLiveDirectives(
  project: string,
  compose: () => string | undefined,
  initial: string | undefined,
) {
  let applied = initial
  let supported: boolean | undefined
  let tail = Promise.resolve(true)
  return (request: PiRpcClient['request'], folder?: string) => {
    if (folder && folder !== project) return Promise.resolve(true)
    tail = tail
      .catch(() => false)
      .then(async () => {
        const next = compose()
        if (next === applied) return true
        if (supported === undefined) {
          const check = await request({ type: 'get_commands' })
          if (!check.success) return false
          supported =
            check.data?.commands.some(
              (cmd) => cmd.name === 'phosphor-directives' && cmd.source === 'extension',
            ) ?? false
        }
        if (!supported) return false // An unknown slash command would reach the model.
        const arg = next ? Buffer.from(next).toString('base64') : '-'
        const sent = await request({ type: 'prompt', message: `/phosphor-directives ${arg}` })
        if (sent.success) applied = next
        return sent.success
      })
    return tail
  }
}
