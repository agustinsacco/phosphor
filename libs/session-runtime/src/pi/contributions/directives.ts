import { directiveDelivery } from '@phosphor/shared/agent-directives'
import type { SpawnContribution } from '../spawn-contributions'

export function createDirectivesContribution(): SpawnContribution {
  return {
    name: 'directives',
    spawn: (_execution, { appendSystemPrompt }) =>
      appendSystemPrompt ? { env: directiveDelivery(appendSystemPrompt).env } : undefined,
  }
}
