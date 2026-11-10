import { describe, expect, it } from 'vitest'
import { ciScope, JOB_PROJECTS } from './ci-scope.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const ALL = { e2e: true, web: true, control: true, site: true }

function runner({
  files = ['apps/site/src/pages/index.astro'],
  projects = ['site', 'tooling'] as unknown,
  revs = { HEAD: head, 'HEAD^1': base } as Record<string, string>,
  failNx = false,
} = {}) {
  return (command: string, args: string[]): string => {
    if (command === 'git' && args[0] === 'rev-parse') return revs[args[1]!] ?? ''
    if (command === 'git' && args[0] === 'diff') {
      expect(args).toEqual(['diff', '--name-only', base, head])
      return files.join('\n')
    }
    expect(args).toContain(`--base=${base}`)
    if (failNx) throw new Error('nx failed')
    return JSON.stringify(projects)
  }
}

describe('ciScope', () => {
  it('runs every job on a main push or a manual run', () => {
    for (const event of ['push', 'workflow_dispatch', undefined])
      expect(ciScope(event, () => '').jobs).toEqual(ALL)
  })

  it('runs only the jobs whose projects a PR affects', () => {
    expect(ciScope('pull_request', runner()).jobs).toEqual({
      e2e: false,
      web: false,
      control: false,
      site: true,
    })
    expect(
      ciScope('pull_request', runner({ projects: ['desktop', 'control', 'web', 'tooling'] })).jobs,
    ).toEqual({ e2e: true, web: true, control: true, site: false })
    expect(ciScope('pull_request', runner({ projects: ['schema', 'tooling'] })).jobs).toEqual({
      e2e: false,
      web: false,
      control: true,
      site: false,
    })
  })

  it('skips every optional job for a docs-only PR', () => {
    expect(
      ciScope('pull_request', runner({ files: ['docs/README.md'], projects: ['tooling'] })).jobs,
    ).toEqual({ e2e: false, web: false, control: false, site: false })
  })

  it.each([
    ['a workflow change', runner({ files: ['.github/workflows/ci.yml'], projects: ['tooling'] })],
    ['an unknown merge commit', runner({ revs: { HEAD: head } })],
    ['an Nx failure', runner({ failNx: true })],
    ['an unknown project', runner({ projects: ['site', 'mystery'] })],
    ['a non-list report', runner({ projects: { site: true } })],
  ])('runs everything on %s', (_, execute) => {
    expect(ciScope('pull_request', execute).jobs).toEqual(ALL)
  })

  it('names one job per optional CI job', () => {
    expect(Object.keys(JOB_PROJECTS).sort()).toEqual(['control', 'e2e', 'site', 'web'])
  })
})
