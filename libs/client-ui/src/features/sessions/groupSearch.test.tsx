// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useGroupSearch, type GroupSearch } from './groupSearch'

function renderSearch(): () => GroupSearch {
  let current: GroupSearch | undefined
  function Probe(): null {
    current = useGroupSearch()
    return null
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.createElement('div'))
  act(() => root.render(<Probe />))
  return () => current!
}

it('reads no lane fields until Enter applies the draft, then keeps the matching lanes', () => {
  const search = renderSearch()
  const lanes = [{ title: 'Fix login' }, { title: 'Rebase main' }]
  const fields = vi.fn((lane: { title: string }) => ({ title: lane.title }))
  act(() => search().open())
  act(() => search().setDraft('rebase'))
  expect(search().applied).toBe(false)
  expect(search().filter(lanes, fields)).toBe(lanes)
  expect(fields).not.toHaveBeenCalled()
  act(() => search().commit())
  expect(search().applied).toBe(true)
  expect(search().filter(lanes, fields)).toEqual([{ title: 'Rebase main' }])
  act(() => search().clear())
  expect(search()).toMatchObject({ searching: false, draft: '', query: '', applied: false })
})
