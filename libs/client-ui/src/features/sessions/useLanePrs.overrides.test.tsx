// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LanePrSignals, SessionMeta } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useLanePrOverridesStore } from '@/stores/lanePrOverrides'
import { usePrStatusStore } from '@/stores/prStatus'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { prRef } from './__fixtures__/pullRequests'
import type { LanePrs } from './lanePrs'
import { useLocalLanePrs } from './useLanePrs'

const PATH = '/s/a.jsonl'
const signals = (over: Partial<LanePrSignals> = {}): LanePrSignals => ({
  opened: [prRef(1)],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
  ...over,
})
const meta = (pullRequests: LanePrSignals) =>
  ({ path: PATH, cwd: '/repo', pullRequests }) as Pick<SessionMeta, 'path' | 'cwd' | 'pullRequests'>

let root: Root
let container: HTMLDivElement
let restore: () => void
let seen: LanePrs | undefined
function Row({ scanned }: { scanned: LanePrSignals }) {
  seen = useLocalLanePrs(meta(scanned), undefined)
  return null
}
const owned = () => seen?.owned.map((lane) => lane.number).sort()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLanePrOverridesStore.setState({ byPath: {} })
  usePullRequestsStore.setState({ byRepo: {} })
  usePrStatusStore.setState({ byKey: {} })
  restore = installFakePhosphor(
    createFakePhosphor({ 'gh:prSummaries': async () => ({ byKey: {}, coverage: {} }) }),
  )
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  restore()
  vi.unstubAllGlobals()
})

it('shows a Track or Hide at once, and lets the scan take over once it agrees', () => {
  const scanned = signals()
  act(() => root.render(<Row scanned={scanned} />))
  expect(owned()).toEqual([1])

  act(() => {
    useLanePrOverridesStore.getState().record(PATH, 'pin', prRef(2))
    useLanePrOverridesStore.getState().record(PATH, 'hide', prRef(1))
  })
  expect(owned()).toEqual([2])
  expect(useLanePrOverridesStore.getState().byPath[PATH]).toHaveLength(2)

  // The scan read the pin but not yet the hide.
  act(() => root.render(<Row scanned={signals({ pinned: [prRef(2)] })} />))
  expect(owned()).toEqual([2])
  expect(useLanePrOverridesStore.getState().byPath[PATH]?.map((m) => m.action)).toEqual(['hide'])

  act(() => root.render(<Row scanned={signals({ pinned: [prRef(2)], hidden: [prRef(1)] })} />))
  expect(owned()).toEqual([2])
  expect(useLanePrOverridesStore.getState().byPath).toEqual({})
})
