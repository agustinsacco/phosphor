import type { BrainRoutes, BrainRouteStep } from '@phosphor/shared/brain-recall'
import { sentence, type Parts, type Ref } from './format-render'
export function routeParts(r: BrainRoutes): Parts {
  const label = (id: string) => r.entities.find((e) => e.id === id)?.label ?? 'unknown'
  function step(s: BrainRouteStep, ref: Ref) {
    if (s.kind === 'relation') return sentence(s.link, r.entities) + ref(s.link.memoryId)
    const cite = ref(s.memoryId)
    return `${label(s.fromId)} and ${label(s.toId)} ${cite ? 'are both named in' + cite : 'appear together'}`
  }
  return {
    header: (ref) => [
      `Routes from ${r.from?.label} to ${r.to?.label}:`,
      ...r.routes.map((steps, i) => `${i + 1}. ${steps.map((s) => step(s, ref)).join(' → ')}`),
    ],
    entries: r.memories.map((memory) => ({ memory, section: 'Memories:' })),
    footer: () => [],
  }
}
