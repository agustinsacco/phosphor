import { describe, expect, it } from 'vitest'
import {
  describeWindowsLaunchFailure,
  parseNpmCmdShim,
  pickNodeExecutable,
  pickWhereMatch,
  resolveWindowsLaunch,
} from './win-launch'

/**
 * These run on every platform on purpose: the code is Windows-only, but the
 * CI that gates a merge is Linux and macOS, and a regression here ships as
 * "pi not found" on every Windows install with no error anywhere.
 */

const NPM_DIR = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
const SHIM = `${NPM_DIR}\\pi.cmd`
const ENTRY = `${NPM_DIR}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js`

/** Verbatim shape of what npm ≥ 7 (cmd-shim 4+) writes for a global bin. */
const MODERN_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r
`

/** The npm ≤ 6 generation, still common on machines that never upgraded npm. */
const LEGACY_SHIM = `@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r
) ELSE (\r
  @SETLOCAL\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r
)\r
`

describe('pickWhereMatch', () => {
  it('skips the POSIX sh shim `where` lists first and takes the .cmd', () => {
    // Exactly what `where pi` prints for a global npm install.
    expect(pickWhereMatch(`${NPM_DIR}\\pi\r\n${SHIM}\r\n${NPM_DIR}\\pi.ps1\r\n`)).toBe(SHIM)
  })

  it('prefers a real executable over a shim', () => {
    expect(pickWhereMatch(`${SHIM}\r\nC:\\Tools\\pi.exe\r\n`)).toBe('C:\\Tools\\pi.exe')
  })

  it('guesses the sibling .cmd when only the extensionless script is listed', () => {
    expect(pickWhereMatch(`${NPM_DIR}\\pi\r\n`)).toBe(SHIM)
  })

  it('returns null for no output', () => {
    expect(pickWhereMatch('')).toBeNull()
    expect(pickWhereMatch('\r\n')).toBeNull()
  })
})

describe('parseNpmCmdShim', () => {
  it('reads the entry script out of a modern cmd-shim', () => {
    expect(parseNpmCmdShim(MODERN_SHIM, NPM_DIR)).toBe(ENTRY)
  })

  it('reads the entry script out of an npm 6 shim', () => {
    expect(parseNpmCmdShim(LEGACY_SHIM, NPM_DIR)).toBe(ENTRY)
  })

  it('accepts .mjs and .cjs entries', () => {
    expect(parseNpmCmdShim('"%_prog%"  "%dp0%\\node_modules\\x\\bin\\run.mjs" %*', 'D:\\bin')).toBe(
      'D:\\bin\\node_modules\\x\\bin\\run.mjs',
    )
  })

  it('returns null for a shim that is not an npm one', () => {
    // Scoop's wrapper: a batch file pointing at another batch file.
    expect(
      parseNpmCmdShim('@rem shim\r\n@"%~dp0\\..\\apps\\pi\\current\\pi.cmd" %*', 'D:\\s'),
    ).toBe(null)
    expect(parseNpmCmdShim('', 'D:\\s')).toBeNull()
  })
})

describe('pickNodeExecutable', () => {
  it('falls back to `where node` when nothing sits beside the shim', () => {
    // `where node` lists only the .exe; there is no sh shim for node itself.
    expect(
      pickNodeExecutable('Z:\\definitely\\missing', 'C:\\Program Files\\nodejs\\node.exe'),
    ).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it('returns null when node is nowhere', () => {
    expect(pickNodeExecutable('Z:\\definitely\\missing', '')).toBeNull()
  })
})

describe('resolveWindowsLaunch', () => {
  const files = new Set([SHIM, ENTRY])
  const deps = {
    readShim: (path: string) => (path === SHIM ? MODERN_SHIM : null),
    whereNode: async () => 'C:\\Program Files\\nodejs\\node.exe\r\n',
    exists: (path: string) => files.has(path),
  }

  it('runs an npm-installed pi as node.exe plus the entry script', async () => {
    const result = await resolveWindowsLaunch(`${NPM_DIR}\\pi\r\n${SHIM}\r\n`, deps)
    expect(result).toEqual({
      ok: true,
      launch: { file: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: [ENTRY] },
    })
  })

  it('spawns a real .exe directly with no prefix', async () => {
    const result = await resolveWindowsLaunch('C:\\Tools\\pi.exe\r\n', {
      ...deps,
      exists: () => true,
    })
    expect(result).toEqual({ ok: true, launch: { file: 'C:\\Tools\\pi.exe', prefixArgs: [] } })
  })

  it('reports not-found for empty `where` output', async () => {
    expect(await resolveWindowsLaunch('', deps)).toEqual({
      ok: false,
      failure: { kind: 'not-found' },
    })
  })

  it('reports not-found when the picked hit does not exist on disk', async () => {
    expect(await resolveWindowsLaunch('C:\\gone\\pi.cmd\r\n', deps)).toEqual({
      ok: false,
      failure: { kind: 'not-found' },
    })
  })

  it('refuses a shim it cannot read through instead of guessing', async () => {
    const result = await resolveWindowsLaunch(`${SHIM}\r\n`, {
      ...deps,
      readShim: () => '@"%~dp0\\..\\apps\\pi\\current\\pi.cmd" %*',
    })
    expect(result).toEqual({ ok: false, failure: { kind: 'unreadable-shim', shimPath: SHIM } })
  })

  it('reports no-node when the entry exists but node.exe is nowhere', async () => {
    const result = await resolveWindowsLaunch(`${SHIM}\r\n`, { ...deps, whereNode: async () => '' })
    expect(result).toEqual({ ok: false, failure: { kind: 'no-node', shimPath: SHIM } })
  })

  it('treats a failing `where node` like an empty one', async () => {
    const result = await resolveWindowsLaunch(`${SHIM}\r\n`, {
      ...deps,
      whereNode: () => Promise.reject(new Error('exit 1')),
    })
    expect(result).toEqual({ ok: false, failure: { kind: 'no-node', shimPath: SHIM } })
  })
})

describe('describeWindowsLaunchFailure', () => {
  it('names the install command for not-found', () => {
    expect(describeWindowsLaunchFailure({ kind: 'not-found' })).toContain('npm install -g')
  })

  it('names the shim path for the other two', () => {
    expect(describeWindowsLaunchFailure({ kind: 'unreadable-shim', shimPath: SHIM })).toContain(
      SHIM,
    )
    expect(describeWindowsLaunchFailure({ kind: 'no-node', shimPath: SHIM })).toContain('node.exe')
  })
})
