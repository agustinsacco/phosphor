// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectorsStore } from './connectors'

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  useConnectorsStore.setState({ flows: {} })
  // @ts-expect-error partial preload surface
  window.phosphor = { invoke }
})

describe('connector sign-in', () => {
  it('starts pi mcp login in main and follows its pushes', async () => {
    await useConnectorsStore.getState().connect('linear', '/ws')
    expect(invoke).toHaveBeenCalledWith('mcp:authorize', 'linear', '/ws')
    expect(useConnectorsStore.getState().flows.linear).toEqual({ phase: 'starting' })

    const url = 'https://linear.app/oauth/authorize?state=1'
    useConnectorsStore
      .getState()
      .received('linear', { phase: 'awaiting-browser', authorizationUrl: url })
    expect(useConnectorsStore.getState().flows.linear).toEqual({
      phase: 'awaiting-browser',
      authorizationUrl: url,
    })
    // pi opened the browser; a second launch from here would be a duplicate tab.
    expect(invoke).not.toHaveBeenCalledWith('app:openExternal', url)

    useConnectorsStore.getState().received('linear', { phase: 'connected' })
    expect(useConnectorsStore.getState().flows.linear).toEqual({ phase: 'connected' })
  })

  it('shows a failure to start as a failed flow', async () => {
    invoke.mockRejectedValueOnce(new Error('no pi'))
    await useConnectorsStore.getState().connect('linear')
    expect(useConnectorsStore.getState().flows.linear).toEqual({
      phase: 'failed',
      message: 'no pi',
    })
  })

  it('cancels in main and drops the card at once', () => {
    useConnectorsStore.getState().received('linear', { phase: 'starting' })
    useConnectorsStore.getState().cancel('linear')
    expect(invoke).toHaveBeenCalledWith('mcp:cancelAuth', 'linear')
    expect(useConnectorsStore.getState().flows).toEqual({})
  })
})
