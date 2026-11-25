import { expect, it } from 'vitest'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { readyView } from './ready-view'

const ready = {
  type: 'ready',
  protocolVersion: 1,
  hello: { hostVersion: '1.0.0' },
  capabilities: [],
} as unknown as Extract<HostFrame, { type: 'ready' }>
const flags = {
  ops: true,
  laneEditing: true,
  laneContext: true,
  laneReload: true,
  sandboxes: true,
  folderDirectives: true,
  configFiles: true,
  pagedLanes: true,
} as const

it('projects every agent-control flag the Host sends, and false for an older Host', () => {
  expect(readyView({ ...ready, ...flags })).toMatchObject(flags)
  const old = readyView(ready)
  for (const flag of Object.keys(flags)) expect(old).toHaveProperty(flag, false)
  // A reconnect to an older Host forgets what the newer one announced.
  expect({ ...readyView({ ...ready, ...flags }), ...old }).toMatchObject({ ops: false })
})

it("projects ownerLocal only for this machine's own socket", () => {
  expect(readyView({ ...ready, ownerLocal: true })).not.toHaveProperty('ownerLocal')
  expect(readyView({ ...ready, ownerLocal: true }, true).ownerLocal).toBe(true)
  expect(readyView(ready, true).ownerLocal).toBe(false)
})

it.each([true, false])('warm policy is shared on local=%s', (local) => {
  expect(readyView({ ...ready, warmOnOpen: true }, local).warmOnOpen).toBe(true)
  expect(readyView(ready, local).warmOnOpen).toBe(false)
})

it('forgets partial catalogue support on reconnect to an older Host', () => {
  const newer = readyView({ ...ready, partialModels: true })
  expect(newer.partialModels).toBe(true)
  expect({ ...newer, ...readyView(ready) }).toMatchObject({ partialModels: false })
})
