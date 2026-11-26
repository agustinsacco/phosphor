import type { Model } from '@shared/rpc'
import type { ChatItem, CustomItem } from '@/features/chat/chatItems'
import { newItemId } from '@/features/chat/reducer'
import type { ChatSession } from './chat'
import { useExtensionUiStore } from './extensionUi'
import {
  CONTEXT_BREAKDOWN_STATUS_KEY,
  parseContextBreakdown,
} from '@/features/chat/composer/contextBreakdown'

const NOTICE_PREFIX = 'confirmed-model:'

export function modelSwitchNotice(model: Model): CustomItem {
  return {
    id: `${NOTICE_PREFIX}${newItemId()}`,
    kind: 'custom',
    text: `Switched to ${model.name || model.id}`,
    inContext: false,
  }
}

/** These display-only items never go back to pi. Keep them when a lane snapshot rehydrates. */
export function retainModelSwitches(previous: ChatItem[], items: ChatItem[]): ChatItem[] {
  previous.forEach((item, index) => {
    if (item.id.startsWith(NOTICE_PREFIX)) items.splice(index, 0, item)
  })
  return items
}

export function modelChangePatch(
  sessionId: string,
  session: ChatSession,
  model: Model | null | undefined,
): Partial<ChatSession> {
  const previous = session.meta?.model
  if (!previous || !model || (previous.provider === model.provider && previous.id === model.id))
    return {}

  const ui = useExtensionUiStore.getState()
  const current = ui.statuses[sessionId]
  if (current) {
    const statuses = { ...current }
    for (const key of Object.keys(statuses)) {
      if (
        previous.provider !== model.provider &&
        (key === previous.provider ||
          (previous.provider === 'pi-claude-cli' && key.startsWith('claude-')))
      )
        delete statuses[key]
    }
    const breakdown = parseContextBreakdown(statuses[CONTEXT_BREAKDOWN_STATUS_KEY])
    if (breakdown && breakdown.contextWindow !== model.contextWindow)
      delete statuses[CONTEXT_BREAKDOWN_STATUS_KEY]
    useExtensionUiStore.setState({ statuses: { ...ui.statuses, [sessionId]: statuses } })
  }

  const { stats } = session
  const usage = stats?.contextUsage
  const window = model.contextWindow
  return {
    error: null,
    thinkingLevels: null,
    items: [...session.items, modelSwitchNotice(model)],
    ...(stats &&
      window > 0 && {
        stats: {
          ...stats,
          contextUsage: {
            tokens: usage?.tokens ?? null,
            percent: usage?.tokens == null ? null : (usage.tokens / window) * 100,
            contextWindow: window,
          },
        },
      }),
  }
}
