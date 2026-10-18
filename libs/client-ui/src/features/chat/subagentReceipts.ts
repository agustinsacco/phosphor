import type { ChatItem, CustomItem } from './chatItems'
import { SUBAGENT_SLASH_RESULT_TYPE } from './subagentRuns'

/** Presentation-only replacement. Pi's original entries remain untouched. */
export function appendCustomItem(items: ChatItem[], item: CustomItem): void {
  const details = item.details as { requestId?: unknown } | undefined
  if (
    item.customType === SUBAGENT_SLASH_RESULT_TYPE &&
    typeof details?.requestId === 'string' &&
    details.requestId
  ) {
    const at = items.findLastIndex(
      (prior) =>
        prior.kind === 'custom' &&
        prior.customType === item.customType &&
        (prior.details as { requestId?: unknown } | undefined)?.requestId === details.requestId,
    )
    if (at >= 0) {
      items[at] = { ...item, id: items[at]!.id }
      return
    }
  }
  items.push(item)
}
