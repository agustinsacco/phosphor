import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap, PhosphorApi } from '@phosphor/shared/ipc'
import { createFakePhosphor } from './fakePhosphor'

// These fixtures are compiled by tsconfig.web, but never invoke invalid calls at runtime.
function compileContract() {
  const fake = createFakePhosphor({
    'pi:commands': (workspacePath) => {
      expectTypeOf(workspacePath).toEqualTypeOf<string | undefined>()
      return { commands: [] }
    },
    'mcp:authorize': async (server, workspacePath) => {
      expectTypeOf(server).toEqualTypeOf<string>()
      expectTypeOf(workspacePath).toEqualTypeOf<string | undefined>()
    },
  })
  expectTypeOf(fake.api).toEqualTypeOf<PhosphorApi>()
  expectTypeOf(fake.api.invoke('pi:commands')).toEqualTypeOf<
    Promise<IpcInvokeMap['pi:commands']['result']>
  >()
  const command = fake.api.piCommand('session', { type: 'get_commands' })
  void command.then((response) => {
    if (response.success && response.data) expectTypeOf(response.data.commands).toBeArray()
  })
  // @ts-expect-error unknown IPC channel is not a valid invocation
  fake.api.invoke('not:a:channel')
  // @ts-expect-error required server argument cannot be omitted
  fake.api.invoke('mcp:authorize')
  // @ts-expect-error IPC argument types are channel-specific
  fake.api.invoke('mcp:authorize', 12)
  // @ts-expect-error inferred result cannot be assigned to an unrelated promise
  const wrongResult: Promise<string> = fake.api.invoke('pi:commands')
  void wrongResult
  createFakePhosphor({
    // @ts-expect-error handler argument types must match the channel
    'mcp:authorize': (server: number) => {
      void server
    },
  })
  // @ts-expect-error handler result must match the channel
  createFakePhosphor({ 'pi:commands': () => 'wrong result' })
  // @ts-expect-error async handler result must also match the channel
  createFakePhosphor({ 'pi:commands': async () => 123 })
  // @ts-expect-error overrides cannot introduce unknown channels
  createFakePhosphor({ 'not:a:channel': () => undefined })
  // @ts-expect-error keyed emitters require a string key
  fake.events.onPtyData.emit(12, 'data')
  // @ts-expect-error exit payloads are numbers, not strings
  fake.events.onPtyExit.emit('pty', 'zero')
  // @ts-expect-error event payloads retain their shared-contract shape
  fake.events.onFsChanged.emit({ paths: [] })
  // @ts-expect-error RPC commands preserve their command-specific arguments
  fake.api.piCommand('session', { type: 'set_model' })
}

it('keeps the compile-only contract fixture available to the web typecheck', () => {
  expectTypeOf(compileContract).toBeFunction()
})
