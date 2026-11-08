// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserHandlers } from './handlers'

/* Export of a Host skill: the page zips the bundle and downloads it; nothing native is asked. */
function saveBundle() {
  const proxy = new Proxy({}, { get: () => () => undefined })
  const handlers = createBrowserHandlers({
    ...{ control: proxy, hosts: proxy, resources: proxy, prefs: proxy, drafts: proxy },
    lanes: proxy,
    window: () => proxy,
    openExternal: () => {},
    broadcastLogout: () => {},
    machinesChanged: () => {},
  } as never)
  return handlers['skills:saveBundle']
}
afterEach(() => vi.restoreAllMocks())

it('downloads a valid bundle as <name>.zip, an octet stream', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => 'blob:x')
  const bundle = { name: 'demo', files: [{ path: 'SKILL.md', data: btoa('skill') }] }
  expect(await saveBundle()(bundle)).toEqual({ savedTo: 'demo.zip' })
  expect(click).toHaveBeenCalledOnce()
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('demo.zip')
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob
  expect(blob.type).toBe('application/octet-stream')
  expect(new TextDecoder().decode(await blob.arrayBuffer())).toContain('demo/SKILL.md')
})

it('refuses an invalid bundle without downloading', () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const escaping = { name: 'demo', files: [{ path: '../SKILL.md', data: btoa('x') }] }
  expect(() => saveBundle()(escaping)).toThrow('This skill bundle is not valid.')
  expect(click).not.toHaveBeenCalled()
})
