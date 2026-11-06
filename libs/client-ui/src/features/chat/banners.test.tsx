// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostLaneSession, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { bootstrapSession, useSessionsStore } from '@/stores/sessions'
import type { HostLaneView } from '@phosphor/shared/ipc'
import { ChatView } from './ChatView'

vi.mock('./MessageList', () => ({ MessageList: () => null }))
vi.mock('./Composer', () => ({ Composer: () => null }))
vi.mock('./composer/RateLimitBanner', () => ({ RateLimitBanner: () => null }))
vi.mock('@/features/extension-ui/ExtensionUiHosts', () => ({ StatusStrip: () => null }))

let root: Root | undefined
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke = vi.fn(async () => undefined)
  vi.stubGlobal('phosphor', { invoke })
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  useChatStore.setState({ sessions: {} })
  vi.unstubAllGlobals()
})

async function renderHostLane(
  activity: HostLaneView['activity'],
  self: boolean,
): Promise<HTMLElement> {
  const { hosts, live } = hostLaneSession({ activity, self })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
  return render(mockRemoteInfo.sessionId, mockRemoteInfo.workspacePath)
}

async function render(sessionId: string, workspacePath: string): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () =>
    root!.render(<ChatView sessionId={sessionId} workspacePath={workspacePath} />),
  )
  return el
}

const resumeSession = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Resume session')

it("says when This Mac's pi crashed and offers to resume the session", async () => {
  useChatStore.getState().ensure('local')
  useChatStore.getState().setError('local', 'pi exited unexpectedly (code 1).')
  useSessionsStore.setState({
    live: { local: { phosphorId: 'local', sessionId: 'local', workspacePath: '/w' } } as never,
  })
  const el = await render('local', '/w')
  expect(el.textContent).toContain('pi crashed')
  expect(el.textContent).toContain('pi exited unexpectedly (code 1).')
  expect(resumeSession(el)?.disabled).toBe(false)
})

it("says when a Host lane's pi crashed and resumes it on the Host", async () => {
  const el = await renderHostLane('failed', true)
  expect(el.textContent).toContain('pi crashed')
  expect(el.textContent).toContain(`pi exited unexpectedly on ${MOCK_HOST_ID}`)
  await act(async () => resumeSession(el)!.click())
  expect(invoke).toHaveBeenCalledWith('hosts:resumeLane', MOCK_HOST_ID, mockRemoteInfo.laneId)
})

it('asks a viewer of a crashed Host lane to take control before resuming', async () => {
  const el = await renderHostLane('failed', false)
  const resume = resumeSession(el)
  expect(resume?.disabled).toBe(true)
  expect(resume?.getAttribute('data-tooltip')).toBe('Take control first.')
  expect(invoke).not.toHaveBeenCalledWith('hosts:resumeLane', expect.anything(), expect.anything())
})

it.each(['stopped', 'idle'] as const)('shows no crash for a %s Host lane', async (activity) => {
  const el = await renderHostLane(activity, true)
  expect(el.textContent).not.toContain('pi crashed')
})

it("offers a crashed Host lane's controller one Resume, the banner's", async () => {
  const el = await renderHostLane('failed', true)
  const resumes = [...el.querySelectorAll('button')].filter((b) =>
    b.textContent?.startsWith('Resume'),
  )
  expect(resumes.map((b) => b.textContent)).toEqual(['Resume session'])
})

it("keeps the control row's Resume for a stopped Host lane, with no crash banner", async () => {
  const el = await renderHostLane('stopped', true)
  const resumes = [...el.querySelectorAll('button')].filter((b) =>
    b.textContent?.startsWith('Resume'),
  )
  expect(resumes.map((b) => b.textContent)).toEqual(['Resume'])
})

function noModels(sessionId: string): void {
  useChatStore.getState().ensure(sessionId)
  useChatStore.getState().setMeta(sessionId, { sessionId } as never)
  useChatStore.getState().setModels(sessionId, [])
}
const buttonTexts = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('button')].map((b) => b.textContent ?? '')

it("offers This Mac's start picker actions and pi's terminal when a lane has no models", async () => {
  useSessionsStore.setState({
    live: { local: { phosphorId: 'local', sessionId: 'local', workspacePath: '/w' } } as never,
  })
  noModels('local')
  const el = await render('local', '/w')
  expect(el.textContent).toContain('No models configured')
  expect(el.textContent).not.toContain('/login')
  expect(buttonTexts(el)).toEqual(
    expect.arrayContaining(['Retry models', 'Open terminal with `pi`']),
  )
  expect(buttonTexts(el).some((text) => text.startsWith('Sign in on '))).toBe(true)
})

it("offers a Host lane's Sign in on the Host and never This Mac's terminal", async () => {
  const { hosts, live } = hostLaneSession({ self: true })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
  noModels(mockRemoteInfo.sessionId)
  const el = await render(mockRemoteInfo.sessionId, mockRemoteInfo.workspacePath)
  expect(buttonTexts(el)).toContain('Retry models')
  expect(buttonTexts(el)).toContain(`Sign in on ${MOCK_HOST_ID}`)
  expect(buttonTexts(el)).not.toContain('Open terminal with `pi`')
})

it('Retry models reads the lane models again and drops the banner once some arrive', async () => {
  const piCommand = vi.fn(async () => ({
    success: true,
    data: { models: [{ id: 'm', name: 'Model', provider: 'p', reasoning: false }] },
  }))
  vi.stubGlobal('phosphor', { invoke, piCommand })
  useSessionsStore.setState({
    live: { local: { phosphorId: 'local', sessionId: 'local', workspacePath: '/w' } } as never,
  })
  noModels('local')
  const el = await render('local', '/w')
  const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry models')
  expect(retry).toBeDefined()
  await act(async () => retry?.click())
  expect(piCommand).toHaveBeenCalledWith('local', { type: 'get_available_models' })
  expect(el.textContent).not.toContain('No models configured')
})

it('says a failed model read failed, with Retry models, instead of "No models configured"', async () => {
  const piCommand = vi.fn(async (_id: string, command: { type: string }) =>
    command.type === 'get_state'
      ? { success: true, data: { sessionId: 'local' } }
      : { success: false, error: 'pi is busy' },
  )
  vi.stubGlobal('phosphor', { invoke, piCommand })
  useSessionsStore.setState({
    live: { local: { phosphorId: 'local', sessionId: 'local', workspacePath: '/w' } } as never,
  })
  useChatStore.getState().ensure('local')
  await bootstrapSession('local')
  const el = await render('local', '/w')
  expect(el.textContent).toContain('Could not read models.')
  expect(el.textContent).not.toContain('No models configured')
  expect(buttonTexts(el)).toContain('Retry models')
})
