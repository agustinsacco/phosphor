import { BRAIN_LINK_RULES } from '@phosphor/shared/brain'

export function linkRules(): string {
  return Object.entries(BRAIN_LINK_RULES)
    .map(
      ([predicate, rule]) => `${predicate}: ${rule.subject.join(', ')} → ${rule.object.join(', ')}`,
    )
    .join('\n')
}
