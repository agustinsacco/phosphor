import { decideLocalRuntimeMode } from '../../local-machine/mode'
import { bindSameMachine } from '../../local-machine/same-machine'
import {
  fakeLocalService,
  type FakeLocalService,
} from '../../local-machine/__fixtures__/local-service'

/**
 * Decides daemon mode for this test file and binds This Mac's service: a fake
 * whose working lanes are `state.live`, so a suite written for the in-app
 * registry runs unchanged against the service's projection and leases.
 */
export function enterDaemonMode(state: {
  live: ReadonlyArray<{ workspacePath: string }>
}): FakeLocalService {
  const fake = fakeLocalService()
  Object.defineProperty(fake, 'lanes', {
    get: () =>
      state.live.map((lane, i) => ({
        laneId: `lane-${i}`,
        cwd: lane.workspacePath,
        activity: 'working' as const,
      })),
  })
  decideLocalRuntimeMode('daemon', {
    location: { kind: 'dev', socket: '/tmp/m2b/s.sock', configDir: '/tmp/m2b/config' },
    ownerKey: () => Promise.reject(new Error('unused')),
  })
  bindSameMachine({ hostId: fake.hostId, connection: () => fake.connection })
  return fake
}
