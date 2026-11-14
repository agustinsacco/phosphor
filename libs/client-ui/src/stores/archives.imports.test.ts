// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())
it.each(['sessions', 'remoteLanes', 'machines', 'archives'])(
  'can initialize %s first without an archive subscription cycle',
  async (name) => {
    await expect(import(`./${name}`)).resolves.toBeDefined()
  },
)
