import { expect, it } from 'vitest'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { commandRefusal, mayRunExtensionCommand } from './command-policy'

it.each([
  [{ type: 'prompt', message: '/extension' }, true],
  [{ type: 'prompt', message: '/' }, true],
  [{ type: 'prompt', message: 1 }, true],
  [{ type: 'prompt' }, true],
  [{ type: 'prompt', message: ' /extension' }, false],
  [{ type: 'prompt', message: '' }, false],
  [{ type: 'steer', message: '/extension' }, false],
] as const)('classifies extension prompt %j', (command, expected) => {
  expect(mayRunExtensionCommand(command as RpcCommand)).toBe(expected)
})
it('allows ordinary RPC and export defaults but refuses ownership moves and explicit output paths', () => {
  expect(commandRefusal({ type: 'get_state' })).toBeNull()
  expect(commandRefusal({ type: 'export_html', outputPath: undefined })).toBeNull()
  expect(commandRefusal({ type: 'export_html', outputPath: '' })).toBe(
    'export_html takes no output path on a Host',
  )
  expect(commandRefusal({ type: 'clone' })).toMatch(/^clone moves pi/)
  expect(commandRefusal({ type: 'toString' } as unknown as RpcCommand)).toBe('not a pi command')
})
