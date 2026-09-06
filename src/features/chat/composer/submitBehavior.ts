/** Only used during a running turn: plain Enter steers; modified Enter follows. */
export function submitBehavior(
  event: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey'>,
): 'steer' | 'followUp' {
  return event.altKey || event.metaKey || event.ctrlKey ? 'followUp' : 'steer'
}
