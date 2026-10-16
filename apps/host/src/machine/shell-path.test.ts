import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HOST_PATH_BLOCK, removeHostPathBlocks } from './shell-path'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function home() {
  const value = mkdtempSync(join(tmpdir(), 'host-shell-'))
  homes.push(value)
  return value
}

it('uses exactly the installer block and removes only that block, preserving other bytes', () => {
  expect(readFileSync('tools/host-release/install.sh.in', 'utf8')).toContain(HOST_PATH_BLOCK)
  const root = home()
  for (const name of ['.zshrc', '.bashrc', '.profile']) {
    writeFileSync(join(root, name), `export OTHER=keep\n${HOST_PATH_BLOCK}# user suffix\n`)
  }
  removeHostPathBlocks(root, process.getuid?.())
  for (const name of ['.zshrc', '.bashrc', '.profile'])
    expect(readFileSync(join(root, name), 'utf8')).toBe('export OTHER=keep\n# user suffix\n')
})
it('never follows symlinks or changes non-regular, foreign-owned or altered blocks', () => {
  const root = home()
  const target = join(root, 'target')
  writeFileSync(target, HOST_PATH_BLOCK)
  symlinkSync(target, join(root, '.zshrc'))
  mkdirSync(join(root, '.bashrc'))
  writeFileSync(join(root, '.profile'), HOST_PATH_BLOCK)
  removeHostPathBlocks(root, (process.getuid?.() ?? 0) + 1)
  expect(readFileSync(join(root, '.profile'), 'utf8')).toBe(HOST_PATH_BLOCK)
  writeFileSync(join(root, '.profile'), HOST_PATH_BLOCK.replace('export PATH=', 'export CUSTOM='))
  removeHostPathBlocks(root, process.getuid?.())
  expect(readFileSync(target, 'utf8')).toBe(HOST_PATH_BLOCK)
  expect(readFileSync(join(root, '.profile'), 'utf8')).toContain('export CUSTOM=')
})
