import { expect, it } from 'vitest'
import type { HostLaneView } from '@shared/ipc'
import { usedMarkers } from './remoteLaneSessionHelpers'

const lane = (laneId: string, marker?: string) => ({ laneId, marker }) as HostLaneView

it("dims other Host lanes' explicit markers, never the lane's own, a None or an Auto", () => {
  const self = lane('a', '🐙')
  const lanes = [self, lane('b', '🦊'), lane('c', ''), lane('d'), lane('e', '🐙')]
  expect([...usedMarkers(lanes, self)].sort()).toEqual(['🐙', '🦊'].sort())
  expect([...usedMarkers([self], self)]).toEqual([])
})
