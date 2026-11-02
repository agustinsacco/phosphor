// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { BASH_UNCONFIRMED } from '@shared/remote-host'
import { useChatStore } from '@/stores/chat'
import { runShellCommand } from './runShellCommand'

const SESSION = 's1'
const piCommand = vi.fn()

beforeEach(() => {
  piCommand.mockReset()
  ;(window as unknown as { phosphor: unknown }).phosphor = { piCommand }
  useChatStore.setState({ sessions: {} })
})

function item() {
  const items = useChatStore.getState().sessions[SESSION]?.items ?? []
  const bash = items.find((i) => i.kind === 'bash')
  if (bash?.kind !== 'bash') throw new Error('no bash item')
  return bash
}

it('sends pi bash and fills the item from its result', async () => {
  piCommand.mockResolvedValue({
    success: true,
    data: { output: 'hi\n', exitCode: 0, cancelled: false, truncated: false },
  })
  await runShellCommand(SESSION, 'echo hi', true)
  expect(piCommand).toHaveBeenCalledWith(SESSION, {
    type: 'bash',
    command: 'echo hi',
    excludeFromContext: true,
  })
  expect(item()).toMatchObject({ output: 'hi\n', exitCode: 0, running: false })
})

it('says the output was too large when a Host drops it', async () => {
  piCommand.mockResolvedValue({ success: true })
  await runShellCommand(SESSION, 'cat big', false)
  expect(item()).toMatchObject({ exitCode: null, running: false })
  expect(item().output).toContain('too large to return')
})

it('shows a Host deadline as unconfirmed, not as a failure', async () => {
  piCommand.mockResolvedValue({ success: false, error: `bee1: ${BASH_UNCONFIRMED}` })
  await runShellCommand(SESSION, 'npm test', false)
  expect(item()).toMatchObject({ exitCode: null, running: false, unconfirmed: true })
})

it('shows a refusal or a thrown error as a failure', async () => {
  piCommand.mockResolvedValueOnce({ success: false, error: 'bee1: controlled by Laptop' })
  await runShellCommand(SESSION, 'ls', false)
  expect(item()).toMatchObject({ exitCode: -1, output: 'bee1: controlled by Laptop' })
  useChatStore.setState({ sessions: {} })
  piCommand.mockRejectedValueOnce(new Error('ipc gone'))
  await runShellCommand(SESSION, 'ls', false)
  expect(item()).toMatchObject({ exitCode: -1, running: false })
  expect(item().unconfirmed).toBeUndefined()
})
