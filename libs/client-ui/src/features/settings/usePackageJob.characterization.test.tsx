// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { packageJobChannels, renderPackageJob } from './__fixtures__/packageJobs'

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => vi.unstubAllGlobals())

it('streams the output and exit of the job it started', async () => {
  const channels = packageJobChannels()
  const view = await renderPackageJob()
  await act(() => view.job().start(async () => ({ jobId: 'job-1' })))
  expect(view.job()).toMatchObject({ running: true, output: '', exitCode: null })
  act(() => {
    channels.send('job-1', 'Installing npm:pack...\n')
    channels.send('job-1', 'Installed npm:pack\n')
    channels.exit('job-1', 0)
  })
  expect(view.job()).toEqual(
    expect.objectContaining({
      running: false,
      output: 'Installing npm:pack...\nInstalled npm:pack\n',
      exitCode: 0,
    }),
  )
  expect(view.onExit).toHaveBeenCalledExactlyOnceWith(0)
  await view.unmount()
})

it('hears only the latest job', async () => {
  const channels = packageJobChannels()
  const view = await renderPackageJob()
  await act(() => view.job().start(async () => ({ jobId: 'job-1' })))
  await act(() => view.job().start(async () => ({ jobId: 'job-2' })))
  act(() => {
    channels.send('job-1', 'stale\n')
    channels.exit('job-1', 1)
  })
  expect(view.job()).toMatchObject({ running: true, output: '', exitCode: null })
  act(() => channels.exit('job-2', 0))
  expect(view.job()).toMatchObject({ running: false, exitCode: 0 })
  expect(view.onExit).toHaveBeenCalledExactlyOnceWith(0)
  await view.unmount()
})

it('stops listening on reset and on unmount', async () => {
  const channels = packageJobChannels()
  const view = await renderPackageJob()
  await act(() => view.job().start(async () => ({ jobId: 'job-1' })))
  act(() => view.job().reset())
  expect(channels.listening()).toBe(0)
  act(() => channels.exit('job-1', 0))
  expect(view.job()).toMatchObject({ running: false, output: '', exitCode: null })
  expect(view.onExit).not.toHaveBeenCalled()
  await act(() => view.job().start(async () => ({ jobId: 'job-2' })))
  expect(channels.listening()).toBe(2)
  await view.unmount()
  expect(channels.listening()).toBe(0)
})

it('never listens for a job whose id arrives after unmount', async () => {
  const channels = packageJobChannels()
  const view = await renderPackageJob()
  let reply: (value: { jobId: string }) => void = () => {}
  let started: Promise<void> = Promise.resolve()
  act(() => {
    started = view.job().start(
      () =>
        new Promise((resolve) => {
          reply = resolve
        }),
    )
  })
  await view.unmount()
  await act(async () => {
    reply({ jobId: 'job-1' })
    await started
  })
  expect(channels.listening()).toBe(0)
})

it('reports a job that cannot start as exit 127 with its reason', async () => {
  packageJobChannels()
  const view = await renderPackageJob()
  await act(() => view.job().start(() => Promise.reject(new Error('pi binary not found on PATH'))))
  expect(view.job()).toMatchObject({
    running: false,
    exitCode: 127,
    output: expect.stringContaining('pi binary not found on PATH'),
  })
  expect(view.onExit).not.toHaveBeenCalled()
  await view.unmount()
})
