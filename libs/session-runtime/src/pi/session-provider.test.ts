import { expect, it, vi } from 'vitest'
import { prepareProviderAccount } from './session-provider'

function runtime() {
  return {
    defaultProvider: vi.fn(async () => 'pi-claude-cli'),
    packages: vi.fn(async () => [
      { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
    ]),
    account: vi.fn(async () => ({
      id: 'private',
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/slot' },
    })),
  }
}

it('keeps credential affinity for explicit Claude resumes while bypassing native and stub starts', async () => {
  const owner = runtime()
  const options = { workspacePath: '/repo', sessionPath: '/saved', provider: 'pi-claude-cli' }
  expect(await prepareProviderAccount(options, false, owner)).toMatchObject({ id: 'private' })
  expect(owner.account).toHaveBeenCalledExactlyOnceWith({ sessionPath: '/saved' })
  owner.account.mockClear()
  owner.packages.mockClear()
  expect(await prepareProviderAccount({ ...options, provider: 'native' }, false, owner)).toBeNull()
  expect(await prepareProviderAccount(options, true, owner)).toBeNull()
  expect(owner.account).not.toHaveBeenCalled()
  expect(owner.packages).not.toHaveBeenCalled()
})

it('retains best-effort Desktop selection but fails closed for a strict Host', async () => {
  const owner = runtime()
  owner.account.mockRejectedValue(new Error('private metadata unavailable'))
  expect(await prepareProviderAccount({ workspacePath: '/repo' }, false, owner)).toBeNull()
  await expect(
    prepareProviderAccount({ workspacePath: '/repo' }, false, {
      ...owner,
      strictAccountSelection: true,
    }),
  ).rejects.toThrow('private metadata unavailable')
})
