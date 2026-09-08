import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CLI_PACKAGE,
  checkClaudeCliUpdate,
  checkPackageUpdates,
  classifySpec,
  gitDirFromSpec,
  listPackages,
  npmNameFromSpec,
  parseClaudeAuthStatus,
  resolveInstallPath,
  runClaudeUpdate,
} from './packages'
import type { JobSender } from './packages'

describe('classifySpec', () => {
  it('classifies npm, git, and path specs', () => {
    expect(classifySpec('npm:pi-mcp-adapter')).toBe('npm')
    expect(classifySpec('npm:@saccolabs/pi-claude-cli@0.4.0')).toBe('npm')
    expect(classifySpec('git:github.com/user/repo@v1')).toBe('git')
    expect(classifySpec('https://github.com/user/repo')).toBe('git')
    expect(classifySpec('ssh://git@github.com/user/repo')).toBe('git')
    expect(classifySpec('/abs/path/pkg')).toBe('path')
    expect(classifySpec('../relative/pkg')).toBe('path')
  })
})

describe('npmNameFromSpec', () => {
  it('strips the prefix and version, keeping scopes intact', () => {
    expect(npmNameFromSpec('npm:pi-mcp-adapter')).toBe('pi-mcp-adapter')
    expect(npmNameFromSpec('npm:pi-mcp-adapter@1.2.3')).toBe('pi-mcp-adapter')
    expect(npmNameFromSpec('npm:@saccolabs/pi-claude-cli')).toBe('@saccolabs/pi-claude-cli')
    expect(npmNameFromSpec('npm:@saccolabs/pi-claude-cli@0.4.0')).toBe('@saccolabs/pi-claude-cli')
  })
})

describe('gitDirFromSpec', () => {
  it('normalizes the spec forms pi accepts to host/path', () => {
    expect(gitDirFromSpec('git:github.com/user/repo@v1')).toBe('github.com/user/repo')
    expect(gitDirFromSpec('git:git@github.com:user/repo')).toBe('github.com/user/repo')
    expect(gitDirFromSpec('https://github.com/user/repo.git')).toBe('github.com/user/repo')
    expect(gitDirFromSpec('ssh://git@github.com/user/repo@abc123')).toBe('github.com/user/repo')
  })
})

describe('resolveInstallPath', () => {
  const dirs = { settingsDir: '/home/u/.pi/agent', scope: 'global' as const }

  it('maps npm specs into the shared npm prefix', () => {
    expect(resolveInstallPath('npm:@saccolabs/pi-claude-cli@0.4.0', 'npm', dirs)).toBe(
      '/home/u/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli',
    )
  })

  it('maps git specs into the git clone layout', () => {
    expect(resolveInstallPath('git:github.com/user/repo@v1', 'git', dirs)).toBe(
      '/home/u/.pi/agent/git/github.com/user/repo',
    )
  })

  it('resolves relative paths against the settings directory', () => {
    // pi stores home-adjacent local packages as ../../../<name> relative to
    // ~/.pi/agent (verified against pi 0.84.2).
    expect(resolveInstallPath('../../../pkg', 'path', dirs)).toBe('/home/pkg')
    expect(resolveInstallPath('/abs/pkg', 'path', dirs)).toBe('/abs/pkg')
  })
})

describe('parseClaudeAuthStatus', () => {
  it('parses the Claude Code 2.x logged-in JSON shape', () => {
    // Captured from claude 2.1.219 `claude auth status`.
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      apiKeySource: '/login managed key',
      email: 'user@example.com',
    })
    expect(parseClaudeAuthStatus(stdout)).toEqual({
      ok: true,
      loggedIn: true,
      method: 'claude.ai',
      email: 'user@example.com',
    })
  })

  it('parses logged-out state and tolerates leading noise', () => {
    const stdout = 'some banner\n{"loggedIn": false}'
    expect(parseClaudeAuthStatus(stdout)).toEqual({
      ok: true,
      loggedIn: false,
      method: undefined,
      email: undefined,
    })
  })

  it('reports non-JSON output as an error, not a crash', () => {
    expect(parseClaudeAuthStatus('command not found').ok).toBe(false)
    expect(parseClaudeAuthStatus('{broken').ok).toBe(false)
    expect(parseClaudeAuthStatus('').ok).toBe(false)
  })
})

describe('listPackages', () => {
  let home: string
  let workspace: string
  const originalPiDir = process.env.PI_CODING_AGENT_DIR

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'phosphor-packages-'))
    workspace = join(home, 'ws')
    mkdirSync(join(home, 'agent'), { recursive: true })
    mkdirSync(join(workspace, '.pi'), { recursive: true })
    process.env.PI_CODING_AGENT_DIR = join(home, 'agent')
  })

  afterEach(() => {
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalPiDir
    rmSync(home, { recursive: true, force: true })
  })

  const writeSettings = (dir: string, packages: unknown): void => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages }))
  }

  it('returns entries from both scopes with installed-state resolution', async () => {
    // Installed npm package with a pi manifest.
    const installDir = join(home, 'agent', 'npm', 'node_modules', 'demo-pkg')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: 'demo-pkg',
        version: '1.0.0',
        description: 'A demo',
        pi: { extensions: ['index.ts'], skills: ['skills/*.md', '!skills/wip.md'] },
      }),
    )
    writeSettings(join(home, 'agent'), ['npm:demo-pkg', 'npm:not-installed'])
    writeSettings(join(workspace, '.pi'), [{ source: 'npm:demo-proj', extensions: [] }])

    const entries = await listPackages(workspace)
    expect(entries).toHaveLength(3)

    const demo = entries.find((e) => e.spec === 'npm:demo-pkg')!
    expect(demo.scope).toBe('global')
    expect(demo.installed).toBe(true)
    expect(demo.version).toBe('1.0.0')
    expect(demo.resources.extensions).toEqual(['index.ts'])
    // Exclusions are display noise, not resources.
    expect(demo.resources.skills).toEqual(['skills/*.md'])

    const missing = entries.find((e) => e.spec === 'npm:not-installed')!
    expect(missing.installed).toBe(false)
    expect(missing.name).toBe('not-installed')

    const proj = entries.find((e) => e.spec === 'npm:demo-proj')!
    expect(proj.scope).toBe('project')
    expect(proj.filtered).toBe(true)
  })

  it('discovers convention directories when there is no pi manifest', async () => {
    const installDir = join(home, 'agent', 'npm', 'node_modules', 'conv-pkg')
    mkdirSync(join(installDir, 'extensions'), { recursive: true })
    mkdirSync(join(installDir, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'conv-pkg' }))
    writeFileSync(join(installDir, 'extensions', 'main.ts'), '')
    writeFileSync(join(installDir, 'extensions', 'notes.txt'), '')
    writeFileSync(join(installDir, 'skills', 'my-skill', 'SKILL.md'), '')
    writeSettings(join(home, 'agent'), ['npm:conv-pkg'])

    const [entry] = await listPackages()
    expect(entry!.resources.extensions).toEqual(['main.ts'])
    expect(entry!.resources.skills).toEqual(['my-skill'])
  })

  it('handles missing and malformed settings files', async () => {
    await expect(listPackages()).resolves.toEqual([])
    writeFileSync(join(home, 'agent', 'settings.json'), '{not json')
    await expect(listPackages()).resolves.toEqual([])
  })

  it('resolves relative path specs against the settings dir', async () => {
    const pkgDir = join(home, 'local-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'local-pkg' }))
    writeSettings(join(home, 'agent'), ['../local-pkg'])

    const [entry] = await listPackages()
    expect(entry!.kind).toBe('path')
    expect(entry!.installed).toBe(true)
    expect(entry!.installPath).toBe(pkgDir)
  })
})

describe('checkClaudeCliUpdate', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('asks the registry for the Claude Code package, scope-escaped', async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ version: '2.1.258' }), { status: 200 })
    }) as typeof fetch

    expect(await checkClaudeCliUpdate()).toBe('2.1.258')
    expect(seen).toEqual(['https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest'])
    expect(CLAUDE_CLI_PACKAGE).toBe('@anthropic-ai/claude-code')
  })

  it('answers null rather than throwing when the registry is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as typeof fetch
    expect(await checkClaudeCliUpdate()).toBeNull()
  })

  it('answers null on a non-OK response or a version-less body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch
    expect(await checkClaudeCliUpdate()).toBeNull()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
    expect(await checkClaudeCliUpdate()).toBeNull()
  })
})

describe('checkPackageUpdates', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('resolves npm entries and skips git and path ones', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 }),
    ) as typeof fetch

    const entries = [
      { spec: 'npm:@saccolabs/pi-claude-cli', kind: 'npm' },
      { spec: 'git:github.com/user/repo', kind: 'git' },
    ] as Parameters<typeof checkPackageUpdates>[0]

    expect(await checkPackageUpdates(entries)).toEqual({
      'npm:@saccolabs/pi-claude-cli': '9.9.9',
    })
  })
})

describe('runClaudeUpdate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phosphor-claude-update-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Collect one job's streamed output and exit code. */
  function collect(): { sender: JobSender; done: Promise<{ output: string; code: number }> } {
    let output = ''
    let settle: (value: { output: string; code: number }) => void
    const done = new Promise<{ output: string; code: number }>((resolve) => {
      settle = resolve
    })
    const sender: JobSender = {
      isDestroyed: () => false,
      send: (channel, ...args) => {
        if (channel.startsWith('packages:output:')) output += String(args[0])
        if (channel.startsWith('packages:exit:')) settle({ output, code: Number(args[0]) })
      },
    }
    return { sender, done }
  }

  it("runs the CLI's own `update` subcommand and streams its output", async () => {
    const fake = join(dir, 'claude')
    writeFileSync(fake, '#!/bin/sh\necho "got:$*"\n', { mode: 0o755 })

    const { sender, done } = collect()
    await runClaudeUpdate(sender, fake)

    // `update`, not `npm install -g`: npm does not own a native install.
    expect(await done).toEqual({ output: 'got:update\n', code: 0 })
  })

  it('surfaces a missing binary on the job channels instead of throwing', async () => {
    const { sender, done } = collect()
    // An empty override is falsy, so this takes the PATH-resolution branch;
    // point it at a path that cannot spawn to prove failures still report.
    await runClaudeUpdate(sender, join(dir, 'does-not-exist'))

    const result = await done
    expect(result.code).not.toBe(0)
    expect(result.output.length).toBeGreaterThan(0)
  })
})
