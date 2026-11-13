// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainGraph } from '@shared/brain'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { ExplorerGraph } from './ExplorerGraph'
import { MockExplorer } from '../mockExplorer'
const mounts = vi.hoisted(() => vi.fn())
vi.mock('../BrainGraph3D', () => ({
  BrainGraph3D: ({ graph }: { graph: BrainGraph }) => {
    useEffect(() => {
      mounts()
    }, [])
    return <div>{graph.centerId ?? 'overview scene'}</div>
  },
}))
afterEach(() => {
  vi.unstubAllGlobals()
  mounts.mockReset()
})
it('keeps the scene mounted while a new neighbourhood read is pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const explorer = new MockExplorer()
  let done!: (value: BrainGraph) => void
  const fake = createFakePhosphor({
    'brain:overview': () => explorer.graph(null),
    'brain:neighbourhood': () =>
      new Promise((resolve) => {
        done = resolve
      }),
  })
  const restore = installFakePhosphor(fake)
  const container = document.createElement('div')
  const root = createRoot(container)
  const onVisit = vi.fn()
  try {
    await act(async () =>
      root.render(<ExplorerGraph entityId={null} path={null} onVisit={onVisit} />),
    )
    await act(async () =>
      root.render(<ExplorerGraph entityId="harbor" path={null} onVisit={onVisit} />),
    )
    expect(container.textContent).toContain('overview scene')
    await act(async () => done(explorer.graph('harbor')))
    expect(container.textContent).toContain('harbor')
    expect(mounts).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
  }
})
