import { expect, it, vi } from 'vitest'

const fork = vi.fn()
vi.mock('electron', () => ({ utilityProcess: { fork }, app: { getPath: () => '/tmp' } }))

const { createDesktopSearch, searchWorkerEnv } = await import('./search-service')

it('spawns nothing until the first search', () => {
  createDesktopSearch('/brain/brain.sqlite', '/out/brain-search-worker.js')
  expect(fork).not.toHaveBeenCalled()
})

it('gives the search process no tokens or account variables', () => {
  expect(
    searchWorkerEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'a', HF_TOKEN: 'b' }),
  ).toEqual({ PATH: '/bin', HOME: '/h' })
})
