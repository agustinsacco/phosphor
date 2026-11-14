import { expect, it } from 'vitest'
import * as brain from './brain'
it('has only lasting entity kinds and typed rules for every link', () => {
  expect(brain.BRAIN_ENTITY_KINDS).not.toContain('ticket')
  for (const removed of ['blocks', 'affects', 'related_to']) expect(brain.BRAIN_PREDICATES).not.toContain(removed)
  expect(brain).toHaveProperty('BRAIN_LINK_RULES')
  const rules = Reflect.get(brain, 'BRAIN_LINK_RULES') as Record<string, { subject: string[]; object: string[] }>
  expect(Object.keys(rules)).toEqual([...brain.BRAIN_PREDICATES])
  for (const rule of Object.values(rules)) {
    expect(rule.subject.length).toBeGreaterThan(0)
    expect(rule.object.length).toBeGreaterThan(0)
    for (const kind of [...rule.subject, ...rule.object]) expect(brain.BRAIN_ENTITY_KINDS).toContain(kind)
  }
})
