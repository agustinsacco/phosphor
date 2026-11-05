import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchAgentSettings, writeConfigFile } from './agent-settings'
import { upsertMcpServer, type McpDirs } from './mcp-config'

/**
 * This Mac edits the user's own dotfiles: a pi config kept in a dotfiles repo
 * is a symlink, and its mode is the user's choice. Writes go through the link
 * and keep the mode (the Host's private 0600 policy is not This Mac's).
 */
describe('This Mac writes pi config through dotfile links and keeps file modes', () => {
  let dir: string
  let dotfiles: string
  let previousEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-dotfiles-'))
    dotfiles = join(dir, 'dotfiles')
    await mkdir(join(dir, 'agent'), { recursive: true })
    await mkdir(dotfiles, { recursive: true })
    previousEnv = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(dir, 'agent')
  })

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousEnv
    await rm(dir, { recursive: true, force: true })
  })

  async function linked(name: string, content: unknown, mode: number) {
    const target = join(dotfiles, name)
    const link = join(dir, 'agent', name)
    await writeFile(target, JSON.stringify(content))
    await chmod(target, mode)
    await symlink(target, link)
    return { target, link }
  }

  async function expectLinkKept(link: string, target: string, mode: number) {
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(target)
    expect((await stat(target)).mode & 0o777).toBe(mode)
  }

  it('patches settings.json through its link, keeping the link and the mode', async () => {
    const { target, link } = await linked('settings.json', { theme: 'dark' }, 0o640)
    await patchAgentSettings('global', undefined, { defaultModel: 'opus' })
    await expectLinkKept(link, target, 0o640)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      theme: 'dark',
      defaultModel: 'opus',
    })
  })

  it('keeps the mode of a regular settings file', async () => {
    const path = join(dir, 'agent', 'settings.json')
    await writeFile(path, '{}')
    await chmod(path, 0o664)
    await patchAgentSettings('global', undefined, { theme: 'light' })
    expect((await stat(path)).mode & 0o777).toBe(0o664)
  })

  it('clears booleans, numbers and nested values sent as undefined', async () => {
    const path = join(dir, 'agent', 'settings.json')
    await writeFile(
      path,
      JSON.stringify({
        hideThinkingBlock: true,
        defaultModel: 'opus',
        compaction: { enabled: false, reserveTokens: 4096 },
        retry: { maxRetries: 3 },
      }),
    )
    await patchAgentSettings('global', undefined, {
      hideThinkingBlock: undefined,
      compaction: { enabled: undefined },
      retry: { maxRetries: undefined },
    })
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(written.hideThinkingBlock).toBeUndefined()
    expect(written.defaultModel).toBe('opus')
    expect(written.compaction).toEqual({ reserveTokens: 4096 })
    expect((written.retry as Record<string, unknown> | undefined)?.maxRetries).toBeUndefined()
  })

  it('saves a raw config file through its link', async () => {
    const { target, link } = await linked('models.json', { providers: {} }, 0o644)
    await writeConfigFile('models', '{ "providers": { "local": {} } }\n')
    await expectLinkKept(link, target, 0o644)
    expect(await readFile(target, 'utf8')).toBe('{ "providers": { "local": {} } }\n')
  })

  it('upserts an MCP server through a linked mcp.json, keeping its mode', async () => {
    const { target, link } = await linked('mcp.json', { mcpServers: {} }, 0o640)
    const dirs: McpDirs = { home: dir, xdgConfig: join(dir, 'xdg'), piAgent: join(dir, 'agent') }
    await upsertMcpServer('global', undefined, 'docs', { url: 'https://d.test/mcp' }, dirs)
    await expectLinkKept(link, target, 0o640)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      mcpServers: { docs: { url: 'https://d.test/mcp' } },
    })
  })
})
