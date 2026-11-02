import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELEASE_REF, runner, type Run } from '../../pi-ext/release-lease'

export const POLICY = `---
base: main
merge: squash
required_check: CI result
---

Review against AGENTS.md.
`

/** No machine's identity, signing key or hooks reach the fixture's commits. */
const IDENTITY = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]

export interface ReleaseOrigin {
  /** A clone whose origin is a local bare repository with `main` and the policy. */
  work: string
  git: Run
  /**
   * Point origin's `refs/pull/<number>/head`, as GitHub keeps it, at a new commit
   * on main that `edit` makes in the work tree. Returns the commit.
   */
  pull(number: number, edit?: (work: string) => void): Promise<string>
  /** Replace the release ref with exactly these files, as a damaged or older writer might. */
  release(files: Record<string, string>): Promise<void>
  cleanup(): void
}

/** A local origin, so lease tests exercise real compare-and-swap pushes. */
export async function releaseOrigin(policy: string | null = POLICY): Promise<ReleaseOrigin> {
  const root = mkdtempSync(join(tmpdir(), 'phosphor-release-'))
  const work = join(root, 'work')
  await runner('git', root)(['init', '--quiet', '--bare', 'origin.git'])
  await runner('git', root)(['init', '--quiet', 'work'])
  const git = runner('git', work)
  await git(['remote', 'add', 'origin', join(root, 'origin.git')])
  if (policy !== null) {
    mkdirSync(join(work, '.github'))
    writeFileSync(join(work, '.github/release-manager.md'), policy)
  }
  writeFileSync(join(work, 'README.md'), 'fixture\n')
  await git(['add', '.'])
  await git([...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', 'policy'])
  await git(['push', '--quiet', '--no-verify', 'origin', 'HEAD:refs/heads/main'])
  const main = (await git(['rev-parse', 'HEAD'])).trim()
  const pull = async (number: number, edit = (dir: string) => change(dir, number)) => {
    await git(['checkout', '--quiet', '--detach', main])
    edit(work)
    await git(['add', '-A'])
    await git([...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', `pull ${number}`])
    await git(['push', '--quiet', '--no-verify', 'origin', `+HEAD:refs/pull/${number}/head`])
    const head = (await git(['rev-parse', 'HEAD'])).trim()
    await git(['checkout', '--quiet', '--detach', main])
    return head
  }
  const release = async (files: Record<string, string>) => {
    const entries = await Promise.all(
      Object.entries(files).map(async ([name, text]) => {
        const blob = (await git(['hash-object', '-w', '--stdin'], text)).trim()
        return `100644 blob ${blob}\t${name}\n`
      }),
    )
    const tree = (await git(['mktree'], entries.join(''))).trim()
    const commit = (await git([...IDENTITY, 'commit-tree', tree, '-m', 'release'])).trim()
    await git(['push', '--quiet', '--no-verify', '--force', 'origin', `${commit}:${RELEASE_REF}`])
  }
  return { work, git, pull, release, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function change(work: string, number: number): void {
  writeFileSync(join(work, `pull-${number}.txt`), `change ${number}\n`)
}
