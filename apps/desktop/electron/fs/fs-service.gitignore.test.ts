// @vitest-environment node
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { listDir, readTextFile } from './fs-service'

const scratch: string[] = []

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-explorer-'))
  scratch.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('marks ignored directories and files by default without changing dotfile visibility', async () => {
  const dir = await tempRepo()
  await writeFile(join(dir, '.gitignore'), '/built/\n*.log\n')
  await mkdir(join(dir, 'built'))
  await writeFile(join(dir, 'run\nlog.log'), '')
  await writeFile(join(dir, 'keep.txt'), '')
  await expect(listDir(dir, dir, {})).resolves.toMatchObject([
    { name: 'built', isDirectory: true, isIgnored: true },
    { name: 'keep.txt' },
    { name: 'run\nlog.log', isIgnored: true },
  ])
  await expect(listDir(dir, dir, { respectGitignore: true })).resolves.toMatchObject([
    { name: 'keep.txt' },
  ])
})

it('expands an ignored link to a folder outside the repo and opens linked files', async () => {
  const [dir, checkout] = await Promise.all([tempRepo(), tempRepo()])
  await writeFile(join(dir, '.gitignore'), '/artifacts\n/team.json\n')
  await mkdir(join(checkout, 'artifacts', 'reports'), { recursive: true })
  await writeFile(join(checkout, 'artifacts', 'reports', 'report.md'), '# Lane report')
  await writeFile(join(checkout, 'team.json'), '{}')
  const link = join(dir, 'artifacts')
  await symlink(join(checkout, 'artifacts'), link, 'dir')
  await symlink(join(checkout, 'team.json'), join(dir, 'team.json'), 'file')

  await expect(listDir(dir, dir, {})).resolves.toMatchObject([
    { name: 'artifacts', isDirectory: true, isIgnored: true, symlink: 'resolved' },
    { name: 'team.json', isDirectory: false, isIgnored: true, symlink: 'resolved' },
  ])
  await expect(listDir(dir, dir, { respectGitignore: true })).resolves.toEqual([])
  await expect(listDir(dir, join(link, 'reports'), {})).resolves.toMatchObject([
    { path: join(link, 'reports', 'report.md'), isIgnored: true },
  ])
  await expect(readTextFile(join(link, 'reports', 'report.md'))).resolves.toMatchObject({
    content: '# Lane report',
  })
  await expect(readTextFile(join(dir, 'team.json'))).resolves.toMatchObject({ content: '{}' })
})

it('shows a symlink loop without allowing it to expand', async () => {
  const dir = await tempRepo()
  await mkdir(join(dir, 'nested'))
  await symlink('..', join(dir, 'nested', 'up'), 'dir')
  await symlink('self', join(dir, 'self'), 'dir')
  await expect(listDir(dir, join(dir, 'nested'), {})).resolves.toMatchObject([
    { name: 'up', isDirectory: false, symlink: 'loop' },
  ])
  await expect(listDir(dir, dir, {})).resolves.toMatchObject([
    { name: 'nested', isDirectory: true },
    { name: 'self', isDirectory: false, symlink: 'loop' },
  ])
})

it('shows a broken symlink without treating it as a folder', async () => {
  const dir = await tempRepo()
  await symlink('missing', join(dir, 'broken'), 'dir')
  await expect(listDir(dir, dir, {})).resolves.toMatchObject([
    { name: 'broken', isDirectory: false, symlink: 'unavailable' },
  ])
})

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
