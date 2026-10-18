import { expect, it } from 'vitest'
import {
  rememberRemoteThinking,
  rememberRemoteModel,
  useRemoteModelPicks,
} from './remoteModelPicks'
import { useMachinesStore } from './machines'

it('bounds Host thinking memory and clears it on account loss', () => {
  useMachinesStore.setState({ remoteEnabled: true })
  useRemoteModelPicks.setState({ thinking: {} })
  for (let i = 0; i < 65; i++) {
    rememberRemoteThinking(`host-${i}`, 'high')
    rememberRemoteModel(`host-${i}`, { id: 'm', provider: 'p' })
  }
  expect(Object.keys(useRemoteModelPicks.getState().last)).toHaveLength(64)
  expect(Object.keys(useRemoteModelPicks.getState().thinking)).toHaveLength(64)
  expect(useRemoteModelPicks.getState().thinking['host-0']).toBeUndefined()
  rememberRemoteThinking('host-1', 'low')
  expect(Object.keys(useRemoteModelPicks.getState().thinking)).toHaveLength(64)
  useMachinesStore.setState({ remoteEnabled: false })
  expect(useRemoteModelPicks.getState().thinking).toEqual({})
  expect(useRemoteModelPicks.getState().last).toEqual({})
})
