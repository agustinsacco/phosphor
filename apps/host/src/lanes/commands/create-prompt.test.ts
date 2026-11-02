import { describe, expect, it, vi } from 'vitest'
import type { HostRuntime } from '../../session/runtime'
import { sendFirstPrompt, type FirstPromptPorts } from './create-prompt'

type PiAnswer = Awaited<ReturnType<HostRuntime['command']>>
const accepted: PiAnswer = { type: 'response', command: 'prompt', success: true }
const target = { laneId: 'lane', requestId: 'request' }

function ports(overrides: Partial<FirstPromptPorts> = {}) {
  const logs: unknown[] = []
  const command = vi.fn<HostRuntime['command']>(async () => accepted)
  const value: FirstPromptPorts = {
    runtime: { command, extensionUiResponse: vi.fn() },
    sessionFor: () => 'session',
    log: (_scope, message, data) => logs.push({ message, data }),
    ...overrides,
  }
  return { value, command, logs }
}

describe('sendFirstPrompt', () => {
  it('sends a prompt op under the creation request id and reports acceptance', async () => {
    const p = ports()
    expect(await sendFirstPrompt(p.value, target, 'hello')).toBe(true)
    expect(p.command).toHaveBeenCalledWith('session', {
      type: 'prompt',
      message: 'hello',
      id: 'request',
    })
    expect(p.logs).toEqual([
      { message: 'lane.first_prompt', data: { ...target, outcome: 'accepted' } },
    ])
    expect(JSON.stringify(p.logs)).not.toContain('hello')
  })

  it('reports false only when pi surely never took it', async () => {
    const stopped = ports({ sessionFor: () => null })
    expect(await sendFirstPrompt(stopped.value, target, 'hello')).toBe(false)
    expect(stopped.command).not.toHaveBeenCalled()
    const refused = ports({ refusal: () => 'refused' })
    expect(await sendFirstPrompt(refused.value, target, 'hello')).toBe(false)
    expect(refused.command).not.toHaveBeenCalled()
    const throwing = ports({
      sessionFor: () => {
        throw new Error('projection')
      },
    })
    expect(await sendFirstPrompt(throwing.value, target, 'hello')).toBe(false)
    const error = ports()
    error.command.mockResolvedValueOnce({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'private pi error',
    })
    expect(await sendFirstPrompt(error.value, target, 'hello')).toBe(false)
    expect(error.logs).toEqual([
      { message: 'lane.first_prompt', data: { ...target, outcome: 'refused' } },
    ])
  })

  it('reports nothing when the runtime call throws, since pi may have the prompt', async () => {
    const p = ports()
    p.command.mockRejectedValueOnce(new Error('pi exited'))
    expect(await sendFirstPrompt(p.value, target, 'hello')).toBeUndefined()
    expect(p.logs).toEqual([
      { message: 'lane.first_prompt', data: { ...target, outcome: 'unknown' } },
    ])
  })
})
