import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./invoker', () => ({ resolvePiInvoker: vi.fn() }))
import { resolvePiInvoker } from './invoker'
import { fetchCodexUsage } from './codex-usage'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
it('usage inspection never rotates OAuth credentials in a short-lived subprocess', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-usage-auth-'))
  directories.push(dir)
  const script = join(dir, 'pi.cjs')
  const argv = join(dir, 'argv.json')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2))); console.log('{"status":"not_ready"}')`)
  vi.mocked(resolvePiInvoker).mockResolvedValue({ binaryPath: process.execPath, prefixArgs: [script], env: {} })
  expect(await fetchCodexUsage()).toEqual({ ok: false, error: 'auth-unavailable' })
  expect(JSON.parse(await readFile(argv, 'utf8'))).toEqual([
    'auth', 'check', '--provider', 'openai-codex', '--json', '--credentials', '--no-refresh',
  ])
})
