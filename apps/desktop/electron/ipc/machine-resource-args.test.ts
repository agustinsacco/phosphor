import { describe, expect, expectTypeOf, it } from 'vitest'
import { IPC_SCOPE, type MachineChannel } from '@shared/ipc-scope'
import type { IpcInvokeChannel } from '@shared/ipc'
import {
  MACHINE_RESOURCE_ARGS,
  MAX_SELECTED_KEYS,
  refusesMachineResourceArgs,
  type MachineResourcePolicies,
  type ResourceSelector,
} from './machine-resource-args'

const REMOTE_KEYS = ['host:machine/repository', 'remote-0123456789abcdef']
const LOCAL = '/local/path'
type Policies = MachineResourcePolicies

function isMachineChannel(channel: string): channel is MachineChannel {
  return Object.hasOwn(MACHINE_RESOURCE_ARGS, channel)
}
const channels = Object.keys(MACHINE_RESOURCE_ARGS).filter(isMachineChannel)
const declared = channels.flatMap((channel) => {
  const policy: 'none' | 'routed-pi' | readonly ResourceSelector[] = MACHINE_RESOURCE_ARGS[channel]
  return typeof policy === 'string' ? [] : [{ channel, policy }]
})

/** An options object with one field set, keeping the fields already there. */
function withField(container: unknown, field: string, value: unknown): Record<string, unknown> {
  const fields = typeof container === 'object' && container !== null ? container : {}
  return { ...fields, [field]: value }
}

/** Arguments with a local key at every selected position; optional keys only if asked. */
function localArgs(policy: readonly ResourceSelector[], withOptional: boolean): unknown[] {
  const args: unknown[] = []
  for (const s of policy) {
    if (s.field !== undefined) args[s.arg] = withField(args[s.arg], s.field, undefined)
    if (s.optional && !withOptional) continue
    if (s.each) args[s.arg] = [LOCAL, `${LOCAL}/b`]
    else if (s.field === undefined) args[s.arg] = LOCAL
    else args[s.arg] = withField(args[s.arg], s.field, LOCAL)
  }
  return args
}

/** The local arguments with one selected position replaced. */
function withKey(policy: readonly ResourceSelector[], selector: ResourceSelector, key: unknown) {
  const args = localArgs(policy, true)
  if (selector.each) args[selector.arg] = [LOCAL, key]
  else if (selector.field === undefined) args[selector.arg] = key
  else args[selector.arg] = withField(args[selector.arg], selector.field, key)
  return args
}

describe('policy declaration', () => {
  it('classifies every machine channel, and only machine channels', () => {
    const machine = Object.entries(IPC_SCOPE)
      .filter(([, scope]) => scope === 'machine')
      .map(([channel]) => channel)
    expect(Object.keys(MACHINE_RESOURCE_ARGS).sort()).toEqual(machine.sort())
    expect(machine).toHaveLength(175)
    expect(
      Object.entries(MACHINE_RESOURCE_ARGS)
        .filter(([, policy]) => policy === 'routed-pi')
        .map(([channel]) => channel)
        .sort(),
    ).toEqual(['pi:command', 'pi:disposeSession', 'pi:extensionUiResponse', 'pi:listLiveSessions'])
  })

  it('rejects a missing channel and selectors the argument types do not allow', () => {
    expectTypeOf<Omit<Policies, 'fs:readFile'>>().not.toExtend<Policies>()
    expectTypeOf<Policies>().toHaveProperty('pi:createSession')
    expectTypeOf<'app:getPrefs'>().not.toExtend<keyof Policies>()
    type Session = Policies['pi:createSession']
    expectTypeOf<readonly [{ arg: 0; field: 'workspacePath' }]>().toExtend<Session>()
    expectTypeOf<readonly [{ arg: 0; field: 'workspace' }]>().not.toExtend<Session>()
    expectTypeOf<readonly [{ arg: 0; field: 'sessionPath' }]>().not.toExtend<Session>()
    expectTypeOf<
      readonly [{ arg: 0; field: 'workspacePath'; optional: true }]
    >().not.toExtend<Session>()
    expectTypeOf<readonly [{ arg: 1; field: 'workspacePath' }]>().not.toExtend<Session>()
    expectTypeOf<readonly [{ arg: 0 }]>().not.toExtend<Session>()
    type Skill = Policies['skills:create']
    expectTypeOf<readonly [{ arg: 0; field: 'workspacePath'; optional: true }]>().toExtend<Skill>()
    expectTypeOf<readonly [{ arg: 0; field: 'workspacePath' }]>().not.toExtend<Skill>()
    expectTypeOf<readonly [{ arg: 0; field: 'draft' }]>().not.toExtend<Skill>()
    type Install = Policies['skills:install']
    expectTypeOf<
      readonly [{ arg: 2; field: 'targetName'; optional: true }]
    >().not.toExtend<Install>()
    type Patch = Policies['pi:patchAgentSettings']
    expectTypeOf<readonly [{ arg: 2; field: 'model'; optional: true }]>().not.toExtend<Patch>()
    expectTypeOf<readonly [{ arg: 1 }]>().not.toExtend<Patch>()
    expectTypeOf<readonly [{ arg: 0; each: true }]>().not.toExtend<Policies['fs:readFile']>()
    expectTypeOf<readonly [{ arg: 0 }]>().not.toExtend<Policies['fs:statDirs']>()
    expectTypeOf<readonly [{ arg: 2 }]>().not.toExtend<Policies['fs:rename']>()
    expectTypeOf<readonly []>().not.toExtend<Policies['fs:rename']>()
    expectTypeOf<'none'>().not.toExtend<Policies['pi:command']>()
    expectTypeOf<'routed-pi'>().not.toExtend<Policies['fs:readFile']>()
    expectTypeOf<'none'>().toExtend<Policies['fs:readFile']>()
    expectTypeOf<keyof Policies>().toEqualTypeOf<MachineChannel>()
  })
})

describe('refusesMachineResourceArgs', () => {
  it('refuses host: workspaces and remote handles at every declared position', () => {
    let positions = 0
    for (const { channel, policy } of declared) {
      expect(refusesMachineResourceArgs(channel, localArgs(policy, true)), channel).toBe(false)
      for (const selector of policy) {
        positions++
        for (const key of REMOTE_KEYS)
          expect(refusesMachineResourceArgs(channel, withKey(policy, selector, key)), channel).toBe(
            true,
          )
      }
    }
    expect(positions).toBe(133)
  })

  it('refuses the named option and array positions', () => {
    for (const key of REMOTE_KEYS) {
      const refused = (channel: IpcInvokeChannel, ...args: unknown[]) =>
        refusesMachineResourceArgs(channel, args)
      expect(refused('pi:createSession', { workspacePath: LOCAL, forkFrom: key })).toBe(true)
      expect(refused('routines:save', { workspacePath: key }, undefined, 1, undefined)).toBe(true)
      expect(refused('skills:importConfirm', { sourcePath: LOCAL, workspacePath: key })).toBe(true)
      expect(refused('app:saveDialog', { defaultPath: key })).toBe(true)
      expect(refused('fs:searchWorkspace', { searchId: 's', workspacePath: key })).toBe(true)
      expect(refused('git:infoBatch', [LOCAL, LOCAL, key])).toBe(true)
    }
  })

  it('passes absent optional keys, free text, and channels with no resource', () => {
    for (const { channel, policy } of declared)
      expect(refusesMachineResourceArgs(channel, localArgs(policy, false)), channel).toBe(false)
    for (const channel of channels.filter((c) => typeof MACHINE_RESOURCE_ARGS[c] === 'string'))
      expect(refusesMachineResourceArgs(channel, [...REMOTE_KEYS, REMOTE_KEYS]), channel).toBe(
        false,
      )
    for (const key of REMOTE_KEYS) {
      expect(refusesMachineResourceArgs('fs:writeFile', [LOCAL, key, null])).toBe(false)
      expect(refusesMachineResourceArgs('pty:write', ['pty-1', key])).toBe(false)
      expect(refusesMachineResourceArgs('app:recordWorkspace', [key])).toBe(false)
    }
    const nearMisses = ['remote-0123456789ABCDEF', 'remote-0123456789abcdef0', 'xhost:a', 'Host:a']
    for (const key of nearMisses)
      expect(refusesMachineResourceArgs('fs:readFile', [key])).toBe(false)
  })

  it('fails closed on malformed selected containers and keys', () => {
    const notKeys = [1, null, true, [LOCAL], { path: LOCAL }]
    for (const { channel, policy } of declared) {
      for (const selector of policy) {
        const keys = selector.optional ? notKeys : [...notKeys, undefined]
        for (const key of keys)
          expect(refusesMachineResourceArgs(channel, withKey(policy, selector, key)), channel).toBe(
            true,
          )
        if (selector.field === undefined && !selector.each) continue
        const containers = selector.each
          ? [undefined, null, LOCAL, {}, { 0: LOCAL, length: 1 }]
          : [undefined, null, 1, LOCAL, [withField({}, selector.field ?? '', LOCAL)]]
        for (const container of containers) {
          const args = localArgs(policy, true)
          args[selector.arg] = container
          expect(refusesMachineResourceArgs(channel, args), channel).toBe(true)
        }
      }
    }
    const inherited = Object.create({ workspacePath: LOCAL })
    expect(refusesMachineResourceArgs('pi:createSession', [inherited])).toBe(true)
    expect(refusesMachineResourceArgs('app:saveDialog', [Object.create({ defaultPath: 7 })])).toBe(
      false,
    )
  })

  it('bounds selected arrays by length, not their neighbours', () => {
    const keys = (count: number) => Array.from({ length: count }, (_, i) => `${LOCAL}/${i}`)
    for (const channel of ['fs:statDirs', 'git:infoBatch', 'artifacts:list'] as const) {
      expect(refusesMachineResourceArgs(channel, [keys(MAX_SELECTED_KEYS)])).toBe(false)
      expect(refusesMachineResourceArgs(channel, [keys(MAX_SELECTED_KEYS + 1)])).toBe(true)
    }
    const sparse: unknown[] = [LOCAL]
    sparse[2] = LOCAL
    expect(refusesMachineResourceArgs('fs:statDirs', [sparse])).toBe(true)
    expect(
      refusesMachineResourceArgs('pi:generateTitle', [LOCAL, 'm', keys(MAX_SELECTED_KEYS * 2)]),
    ).toBe(false)
  })
})
