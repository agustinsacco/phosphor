// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { setLanePrOverride } from '@/features/sessions/lanePrOverrides'
import { prRef } from '@/features/sessions/__fixtures__/pullRequests'
import { localLanePrs } from '@/features/sessions/useLanePrs'
import { useLanePrOverridesStore } from '@/stores/lanePrOverrides'
import { useSessionsStore } from '@/stores/sessions'
import { installMockPhosphor } from './mockPhosphor'
import { MOCK_LANE_PRS } from './mockPullRequests'

const PATH = '/mock/sessions/a.jsonl'
const CWD = '/Users/dev/projects/phosphor'

async function laneA(): Promise<SessionMeta> {
  const metas = await window.phosphor.invoke('sessions:list', CWD)
  return metas.find((meta) => meta.path === PATH)!
}

beforeEach(async () => {
  installMockPhosphor()
  useLanePrOverridesStore.setState({ byPath: {} })
  const info = await window.phosphor.invoke('pi:createSession', {
    workspacePath: CWD,
    sessionPath: PATH,
  })
  useSessionsStore.setState({
    live: {
      [info.sessionId]: { phosphorId: info.sessionId, workspacePath: CWD, diskPath: PATH },
    },
  })
})

it('tracks and hides PRs on the harness lane, as the next scan of its file would show', async () => {
  const before = await laneA()
  await setLanePrOverride('mock-session-id', 'hide', prRef(57))
  await setLanePrOverride('mock-session-id', 'pin', prRef(61))

  // The overlay shows both at once, over the scan from before the writes.
  const owned = localLanePrs(before, undefined).owned.map((lane) => lane.number)
  expect(owned.sort()).toEqual([58, 61])

  // The mock wrote them where the scan reads, and the scan agrees.
  const after = await laneA()
  expect(after.pullRequests).toMatchObject({ pinned: [prRef(61)], hidden: [prRef(57)] })
  expect(MOCK_LANE_PRS.a).toBe(after.pullRequests)
  useLanePrOverridesStore.getState().settle(PATH, after.pullRequests)
  expect(useLanePrOverridesStore.getState().byPath).toEqual({})

  await setLanePrOverride('mock-session-id', 'clear', prRef(57))
  await setLanePrOverride('mock-session-id', 'clear', prRef(61))
  expect((await laneA()).pullRequests).toMatchObject({ pinned: [], hidden: [] })
})
