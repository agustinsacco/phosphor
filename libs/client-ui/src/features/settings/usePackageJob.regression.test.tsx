// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { packageJobChannels, renderPackageJob } from './__fixtures__/packageJobs'

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => vi.unstubAllGlobals())

it('hears a job that ends before the next render', async () => {
  const channels = packageJobChannels()
  const view = await renderPackageJob()
  // Main sends a fast job's output and exit right behind the reply naming the
  // job (the e2e stub's remove, a failed spawn), before React renders again.
  await act(async () => {
    await view.job().start(async () => ({ jobId: 'job-1' }))
    channels.send('job-1', 'Removed npm:pack\n')
    channels.exit('job-1', 0)
  })
  expect(view.job()).toMatchObject({ running: false, output: 'Removed npm:pack\n', exitCode: 0 })
  expect(view.onExit).toHaveBeenCalledExactlyOnceWith(0)
  await view.unmount()
})

it('hears the latest job, not the one whose reply came last', async () => {
  const channels = packageJobChannels()
  const view = await renderPackageJob()
  let first: (value: { jobId: string }) => void = () => {}
  await act(async () => {
    const earlier = view.job().start(
      () =>
        new Promise((resolve) => {
          first = resolve
        }),
    )
    await view.job().start(async () => ({ jobId: 'job-2' }))
    first({ jobId: 'job-1' })
    await earlier
  })
  act(() => channels.exit('job-1', 1))
  expect(view.job()).toMatchObject({ running: true, exitCode: null })
  act(() => channels.exit('job-2', 0))
  expect(view.job()).toMatchObject({ running: false, exitCode: 0 })
  expect(view.onExit).toHaveBeenCalledExactlyOnceWith(0)
  await view.unmount()
})
