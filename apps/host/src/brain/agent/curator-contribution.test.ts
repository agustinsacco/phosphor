import { expect, it, vi } from 'vitest'
import { createReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import { createBrainCuratorContribution } from './curator-contribution'
import { createBrainAgentLaunchProfile } from './profile'

const folder = '/state/brain/Brain'
const lane = createReservedLane('brain-agent', folder)
const launch = vi.fn(async () => ({
  extensions: ['/bundle/brain-ext/brain-curator.mjs'],
  skills: ['/bundle/skills/brain-agent'],
  connection: { endpoint: '/state/brain/bridge.sock', token: 'curator-token' },
}))
const at = (workspacePath: string) => ({ options: { workspacePath } }) as never
const guard = '/bundle/brain-ext/brain-agent-guard.mjs'
const broad = () => {
  const profile = createBrainAgentLaunchProfile(guard)
  profile.next = 'defrag'
  return profile
}

it('gives the curator tools and connection only to the exact reserved spawn', async () => {
  const curator = createBrainCuratorContribution(lane, launch, broad())
  expect(await curator.spawn({ reserved: lane }, at(folder))).toEqual({
    extensions: ['/bundle/brain-ext/brain-curator.mjs'],
    skills: ['/bundle/skills/brain-agent'],
    brainConnection: { endpoint: '/state/brain/bridge.sock', token: 'curator-token' },
  })
})

it('gives nothing to the same folder, a look-alike reservation or another folder', async () => {
  const curator = createBrainCuratorContribution(lane, launch, createBrainAgentLaunchProfile(guard))
  launch.mockClear()
  // An ordinary lane in the Brain folder, by any route.
  expect(await curator.spawn({}, at(folder))).toBeUndefined()
  expect(await curator.spawn({ keepLastWorkspace: true }, at(folder))).toBeUndefined()
  // An equal-looking object is not the reservation.
  const twin = createReservedLane('brain-agent', folder)
  expect(await curator.spawn({ reserved: twin }, at(folder))).toBeUndefined()
  // The reservation never travels to another folder.
  expect(await curator.spawn({ reserved: lane }, at('/repos/harbor'))).toBeUndefined()
  expect(launch).not.toHaveBeenCalled()
})

it('gives nothing to a Defrag spawn while Brain is off', async () => {
  const curator = createBrainCuratorContribution(lane, async () => undefined, broad())
  expect(await curator.spawn({ reserved: lane }, at(folder))).toBeUndefined()
})

it('loads the tool guard first into an interactive spawn, even while Brain is off', async () => {
  const profile = createBrainAgentLaunchProfile(guard)
  expect(
    await createBrainCuratorContribution(lane, launch, profile).spawn(
      { reserved: lane },
      at(folder),
    ),
  ).toEqual({
    extensions: [guard, '/bundle/brain-ext/brain-curator.mjs'],
    skills: ['/bundle/skills/brain-agent'],
    brainConnection: { endpoint: '/state/brain/bridge.sock', token: 'curator-token' },
  })
  const off = createBrainCuratorContribution(lane, async () => undefined, profile)
  expect(await off.spawn({ reserved: lane }, at(folder))).toEqual({ extensions: [guard] })
  // A bundle without the guard loads none: the conversation then refuses every message.
  const none = createBrainCuratorContribution(lane, launch, createBrainAgentLaunchProfile(null))
  expect((await none.spawn({ reserved: lane }, at(folder)))?.extensions).toEqual([
    '/bundle/brain-ext/brain-curator.mjs',
  ])
})
