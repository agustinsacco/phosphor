import type { BrainEntityKind } from '@shared/brain'

export const GRAPH_COLORS: Record<BrainEntityKind, string> = {
  person: '--px-accent',
  team: '--px-success',
  organization: '--px-warning',
  project: '--px-text',
  component: '--px-text-secondary',
  document: '--px-danger',
  concept: '--px-text-tertiary',
  ticket: '--px-warning',
  event: '--px-border-strong',
}

export interface GraphTheme {
  kinds: Record<BrainEntityKind, string>
  text: string
  accent: string
  edge: string
}

export function readGraphTheme(): GraphTheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    kinds: Object.fromEntries(
      Object.entries(GRAPH_COLORS).map(([kind, name]) => [kind, token(name)]),
    ) as Record<BrainEntityKind, string>,
    text: token('--px-text'),
    accent: token('--px-accent'),
    edge: token('--px-border-strong'),
  }
}
