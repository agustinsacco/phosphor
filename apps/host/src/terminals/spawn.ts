import type { HostPtyModule } from './native'
import type { TerminalOptions } from './service-state'

export function spawnTerminal(
  options: TerminalOptions,
  ...args: Parameters<HostPtyModule['spawn']>
) {
  try {
    return options.native.spawn(...args)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : 'Native spawn failed'
    options.context.log('terminal.spawn_failed', { message: message.replace(/\s/g, ' ') })
    throw error
  }
}
