import { expect, expectTypeOf, it } from 'vitest'
import { IPC_SCOPE, type MachineChannel } from './ipc-scope'
import { LOCAL_ROUTE, resolvesSameMachine, type LocalRoute } from './ipc-local-route'

type Routed = keyof typeof LOCAL_ROUTE

it('routes exactly the machine channels, checked at compile time', () => {
  // A machine channel without a route, or a route for any other channel, does not compile.
  expectTypeOf<Exclude<MachineChannel, Routed>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Routed, MachineChannel>>().toEqualTypeOf<never>()
  expectTypeOf<(typeof LOCAL_ROUTE)[Routed]>().toExtend<LocalRoute>()
  const machine = Object.entries(IPC_SCOPE)
    .filter(([, scope]) => scope === 'machine')
    .map(([channel]) => channel)
  expect(Object.keys(LOCAL_ROUTE).sort()).toEqual(machine.sort())
})

it('leases exactly the handlers that consulted the in-app registry before removing or recreating', () => {
  const leased = Object.entries(LOCAL_ROUTE).filter(([, route]) => route === 'leased')
  expect(leased.map(([channel]) => channel).sort()).toEqual([
    'git:removeWorktree',
    'maintenance:run',
    'sessions:recreateWorktree',
    'sessions:restoreWorktree',
  ])
})

it('fails closed for every lane start, session write and pi config write', () => {
  for (const channel of [
    'pi:createSession',
    'pi:generateTitle',
    'pi:writeConfigFile',
    'pi:patchAgentSettings',
    'sessions:appendLabel',
    'sessions:jump',
    'sessions:forkAt',
    'sessions:delete',
    'sessions:archive',
    'skills:create',
    'skills:writeFile',
    'packages:run',
    'mcp:upsertServer',
    'routines:run',
    'pty:create',
  ] as const)
    expect(LOCAL_ROUTE[channel]).toBe('in-app-only')
})

it('serves files, previews, git and gh reads on this machine', () => {
  for (const [channel, route] of Object.entries(LOCAL_ROUTE)) {
    if (/^(fs|git|gh):/.test(channel) && channel !== 'git:createLaneWorktree')
      expect([channel, route === 'app' || resolvesSameMachine(route)]).toEqual([channel, true])
  }
  expect(resolvesSameMachine('host')).toBe(false)
  expect(resolvesSameMachine('in-app-only')).toBe(false)
})
