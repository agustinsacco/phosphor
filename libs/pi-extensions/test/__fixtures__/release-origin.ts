import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runner, type Run } from '../../pi-ext/release-lease'

export const POLICY = `---
base: main
merge: squash
required_check: CI result
---

Review against AGENTS.md.
`

export interface ReleaseOrigin {
  /** A clone whose origin is a local bare repository with `main` and the policy. */
  work: string
  git: Run
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
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'policy',
  ])
  await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  return { work, git, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
