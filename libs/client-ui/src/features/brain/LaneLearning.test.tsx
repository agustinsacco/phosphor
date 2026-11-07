// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakePhosphor, installFakePhosphor } from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { LaneLearningHost } from './LaneLearningHost'
import { LearningIndicator } from './LearningIndicator'
import { useLearningUi, openLearning } from './learningUi'
import { brainFixture } from './__fixtures__/brain'
import { learningJob, learningPreview } from './__fixtures__/learning'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { PlatformProvider, DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'

let root: Root, container: HTMLDivElement, restore: () => void, dispose: () => void
const preview = vi.fn(), learn = vi.fn(), jobs = vi.fn(), detail = vi.fn(), review = vi.fn(), cancel = vi.fn()
async function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function mount(browser = false): Promise<void> {
  await act(async () => root.render(<PlatformProvider value={browser ? WIDE_BROWSER_PLATFORM : DESKTOP_PLATFORM}>
    <LaneLearningHost ready /><LearningIndicator sessionPath={learningPreview.target.sessionPath} />
  </PlatformProvider>))
}
async function open(): Promise<void> {
  await act(async () => openLearning(learningPreview.target))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }), configurable: true })
  useRemoteLanesStore.setState({ filter: 'local' })
  useLearningUi.setState({ target: null, jobId: null, jobs: [], truncated: false, refresh: 0 })
  preview.mockReset().mockResolvedValue(structuredClone(learningPreview))
  learn.mockReset().mockResolvedValue(learningJob())
  jobs.mockReset().mockResolvedValue({ items: [], truncated: false })
  detail.mockReset().mockResolvedValue({ job: learningJob(), outcome: null, proposalId: null })
  review.mockReset().mockResolvedValue(undefined)
  cancel.mockReset().mockResolvedValue(undefined)
  const fake = createFakePhosphor({
    'brain:learnPreview': preview, 'brain:learn': learn, 'brain:learningJobs': jobs,
    'brain:learningDetail': detail, 'brain:status': async () => brainFixture(),
    'brain:review': review, 'brain:cancel': cancel,
  })
  restore = installFakePhosphor(fake); dispose = fake.dispose
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  restore(); dispose(); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers()
})
it('preflights source binding with no manual processor, exact checkpoint and consent epoch/fingerprint', async () => {
  await mount(); await open()
  expect(document.body.textContent).toContain('source-provider/source-model')
  expect(document.body.textContent).toContain('configured-slot')
  expect(document.body.textContent).toContain('selected-leaf')
  expect(document.body.textContent).toContain('projected-digest')
  expect(learn).not.toHaveBeenCalled()
  await act(async () => (document.querySelector('input[type=checkbox]') as HTMLInputElement).click())
  await click('Learn once')
  expect(learn).toHaveBeenCalledWith(learningPreview.target, { policyEpoch: 2, fingerprint: 'exact-fingerprint' })
  expect(document.body.textContent).toContain('Private learning inspector · read-only')
})
it('recovers a failed first preflight without starting inference', async () => {
  preview.mockRejectedValueOnce(new Error('preflight unavailable'))
  await mount(); await open()
  expect(document.body.textContent).toContain('preflight unavailable')
  await click('Retry preflight')
  expect(preview).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain('source-provider/source-model')
  expect(learn).not.toHaveBeenCalled()
})
it('hides stale target and machine responses, and never calls local Brain in the browser', async () => {
  let resolve!: (value: typeof learningPreview) => void
  preview.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await mount(); await open()
  const target = { ...learningPreview.target, sessionPath: '/synthetic/other.jsonl' }
  preview.mockResolvedValueOnce({ ...learningPreview, target, binding: { ...learningPreview.binding, modelId: 'new-model' } })
  await act(async () => openLearning(target))
  await act(async () => resolve(learningPreview))
  expect(document.body.textContent).toContain('new-model')
  expect(document.body.textContent).not.toContain('source-provider/source-model')
  await act(async () => useRemoteLanesStore.setState({ filter: 'host-machine' }))
  expect(document.body.textContent).not.toContain('new-model')
  preview.mockClear(); jobs.mockClear(); await mount(true); await open()
  expect(preview).not.toHaveBeenCalled(); expect(jobs).not.toHaveBeenCalled()
})
it('requires an explicit paid retry for interrupted attempts; never retries on load', async () => {
  preview.mockResolvedValue({ ...learningPreview, previousJobId: 'old-job' })
  detail.mockResolvedValue({ job: learningJob({ id: 'old-job', state: 'interrupted' }), outcome: null, proposalId: null })
  await mount(); await open()
  expect(document.body.textContent).toContain('may incur another charge')
  expect(learn).not.toHaveBeenCalled()
  await act(async () => (document.querySelector('input[type=checkbox]') as HTMLInputElement).click())
  await click('Retry / reprocess explicitly')
  expect(learn).toHaveBeenCalledWith(learningPreview.target, { policyEpoch: 2, fingerprint: 'exact-fingerprint', retryJobId: 'old-job' })
})
it('shares one bounded projection, links a blue indicator to a readonly inspector, and cancels', async () => {
  jobs.mockResolvedValue({ items: [learningJob()], truncated: true })
  await mount()
  expect(jobs).toHaveBeenCalledTimes(1)
  const indicator = document.querySelector('[data-testid=learning-indicator]')!
  expect(indicator.className).toContain('text-blue-')
  expect(document.body.textContent).toContain('Some learning jobs are omitted')
  await click('Learning · running')
  expect(detail).toHaveBeenCalledWith('learning-job')
  expect(document.body.textContent).toContain('selected-leaf')
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.body.textContent).toContain('Unavailable')
  await click('Cancel learning')
  expect(cancel).toHaveBeenCalledWith('learning-job')
  expect(learn).not.toHaveBeenCalled()
})
it('displays no findings and nullable actual usage without inventing a price or cache percentage', async () => {
  const job = learningJob({ state: 'completed' })
  job.learning!.usage = { input: 10, output: 12, cacheRead: null, cacheWrite: 0, reasoning: 5 }
  detail.mockResolvedValue({ job, outcome: { type: 'no_findings' }, proposalId: null })
  await mount(); await act(async () => useLearningUi.setState({ jobId: job.id }))
  expect(document.body.textContent).toContain('Completed · no findings')
  expect(document.body.textContent).toContain('Reasoning (included in output): 5')
  expect(document.body.textContent).toContain('Cache read: Unavailable')
  expect(document.body.textContent).not.toMatch(/\$|cache hit|Approve/)
})
it('stops idle polling and refreshes after returning visible (including restart)', async () => {
  vi.useFakeTimers()
  await mount()
  await act(async () => vi.advanceTimersByTimeAsync(9000))
  expect(jobs).toHaveBeenCalledTimes(1)
  jobs.mockResolvedValue({ items: [learningJob()], truncated: false })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(jobs).toHaveBeenCalledTimes(2)
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(jobs).toHaveBeenCalledTimes(3)
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(jobs).toHaveBeenCalledTimes(3)
})
