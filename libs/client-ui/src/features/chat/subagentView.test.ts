// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { loadSubagentView, saveSubagentView } from './subagentView'
beforeEach(() => localStorage.clear())
it('restores only view/target for the durable Pi identity, not a different session or clone', () => {
  saveSubagentView('pi-id', { view: 'history', target: { runId: 'root', childId: 'child' } })
  expect(loadSubagentView('pi-id')).toEqual({
    view: 'history',
    target: { runId: 'root', childId: 'child' },
  })
  expect(loadSubagentView('new-clone')).toEqual({ view: 'live' })
  expect(localStorage.getItem('phosphor-subagent-view-v1')).not.toMatch(
    /running|inspection|open|status/,
  )
})
it('bounds retained preferences and rejects malformed stored targets', () => {
  for (let i = 0; i < 110; i++) saveSubagentView(String(i), { view: 'live' })
  expect(Object.keys(JSON.parse(localStorage.getItem('phosphor-subagent-view-v1')!))).toHaveLength(
    100,
  )
  localStorage.setItem(
    'phosphor-subagent-view-v1',
    JSON.stringify({ bad: { view: 'x', target: { runId: '--flag' } } }),
  )
  expect(loadSubagentView('bad')).toEqual({ view: 'live' })
  localStorage.setItem('phosphor-subagent-view-v1', 'broken')
  expect(loadSubagentView('bad')).toEqual({ view: 'live' })
})
