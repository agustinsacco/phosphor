import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('creates two missing ancestors and the leaf under umask 0777 without chmod of existing folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-state-umask-'))
  const first = join(root, 'one')
  const second = join(first, 'two')
  const directory = join(second, 'phosphor-host')
  const rootMode = lstatSync(root).mode & 0o777
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `const { prepareStateDirectory } = await import(process.argv[2])
        process.umask(0o777)
        prepareStateDirectory(process.argv[1], process.getuid())
        `,
        directory,
        new URL('./state-dir.ts', import.meta.url).href,
      ],
      { encoding: 'utf8' },
    )
    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    for (const path of [first, second, directory]) expect(lstatSync(path).mode & 0o777).toBe(0o700)
    expect(lstatSync(root).mode & 0o777).toBe(rootMode)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
