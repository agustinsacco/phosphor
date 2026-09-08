// @vitest-environment node
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { listDir } from './fs-service'

describe('listDir gitignore filtering', () => {
  it('filters ignored entries inside a repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phosphor-gi-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    await writeFile(join(dir, '.gitignore'), 'secret.txt\nbuilt/\n')
    await writeFile(join(dir, 'keep.txt'), 'x')
    await writeFile(join(dir, 'secret.txt'), 'x')
    await mkdir(join(dir, 'built'))

    const names = (await listDir(dir, dir, { respectGitignore: true })).map((e) => e.name)
    expect(names).toContain('keep.txt')
    expect(names).not.toContain('secret.txt')
    expect(names).not.toContain('built')
  })

  it('lists everything when nothing is ignored (git exit 1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phosphor-gi-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    await writeFile(join(dir, 'a.txt'), 'x')
    await writeFile(join(dir, 'b.txt'), 'x')
    const names = (await listDir(dir, dir, { respectGitignore: true })).map((e) => e.name)
    expect(names.sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('does not crash or drop entries outside a repo, even with many paths', async () => {
    // Regression: `git check-ignore` exits immediately outside a repo, so a
    // large stdin write hit a closed pipe and the unhandled EPIPE crashed the
    // main process.
    const dir = await mkdtemp(join(tmpdir(), 'phosphor-nonrepo-'))
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => writeFile(join(dir, `f-${i}.txt`), 'x')),
    )
    const entries = await listDir(dir, dir, { respectGitignore: true })
    expect(entries).toHaveLength(300)
  })
})
