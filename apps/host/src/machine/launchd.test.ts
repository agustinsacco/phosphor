import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_AGENT,
  launchAgentPlist,
  launchctlMissing,
  launchdExit,
  launchdStatusLines,
  permanentServiceReason,
  prepareLaunchdRun,
  readLogTail,
  readServiceExit,
  serviceExitPath,
  writeLaunchAgent,
  removeLaunchAgent,
} from './launchd'
import { hostLogDirectory } from './log'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-launchd-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const plist = (path = '/node') => launchAgentPlist(path, path, path, path, path)
describe('launchd', () => {
  it('escapes all strings and renders restart policy, supervisor and only PATH', () => {
    const text = plist('/a&<>"\'b')
    expect(text.match(/\/a&amp;&lt;&gt;&quot;&apos;b/g)).toHaveLength(5)
    expect(text).toContain(`<key>Label</key><string>${HOST_AGENT}</string>`)
    expect(text).toContain('<string>--supervisor</string><string>launchd</string>')
    expect(text).toContain('<key>SuccessfulExit</key><false/>')
    expect(text).toContain('<key>ThrottleInterval</key><integer>10</integer>')
    expect(text).toContain('<key>RunAtLoad</key><true/>')
    expect(text).toContain('<key>ProcessType</key><string>Background</string>')
    expect(text).toContain('<key>StandardOutPath</key><string>/dev/null</string>')
    expect(text).toContain('/launchd.err.log</string>')
  })
  it.skipIf(process.platform !== 'darwin')(
    'lints escaped XML in a temporary directory',
    async () => {
      const path = join(root, 'agent.plist')
      await writeLaunchAgent(path, plist('/a&<>"\'b'))
      expect(execFileSync('plutil', ['-lint', path], { encoding: 'utf8' })).toContain('OK')
    },
  )
  it.each(['relative', '/a\nb', '/a\rb', '/a\u0000b', '/a\u007fb', '/a\u2028b', '/a\u2029b'])(
    'rejects unsafe path %j in each position',
    (path) => {
      for (const index of [0, 1, 2, 4]) {
        const args = ['/node', '/bundle', '/config', '/bin', '/logs']
        args[index] = path
        const [node, bundle, config, envPath, logDir] = args
        if (!node || !bundle || !config || !envPath || !logDir) throw new Error('fixture')
        expect(() => launchAgentPlist(node, bundle, config, envPath, logDir)).toThrow()
      }
    },
  )
  it('rejects control characters and caps PATH and all paths', () => {
    expect(() => launchAgentPlist('/node', '/bundle', '/config', '\n', '/logs')).toThrow(
      'Service paths and PATH must not contain control characters.',
    )
    expect(() => launchAgentPlist('/node', '/bundle', 'relative', '', '/logs')).toThrow(
      'Service paths must be absolute.',
    )
    for (const index of [0, 1, 2, 3, 4]) {
      const args = ['/node', '/bundle', '/config', '/bin', '/logs']
      const render = () => {
        const [a, b, c, d, e] = args
        if (
          a === undefined ||
          b === undefined ||
          c === undefined ||
          d === undefined ||
          e === undefined
        )
          throw new Error('fixture')
        return launchAgentPlist(a, b, c, d, e)
      }
      // logDir also includes the err-log basename within the same string cap.
      args[index] = '/' + 'a'.repeat(index === 4 ? 65519 : 65535)
      expect(render).not.toThrow()
      args[index] += 'a'
      expect(render).toThrow()
    }
  })
  it('writes atomically at 0644 and removes idempotently', async () => {
    const path = join(root, 'LaunchAgents', 'agent.plist')
    await writeLaunchAgent(path, 'old')
    await chmod(path, 0o600)
    await writeLaunchAgent(path, 'new')
    expect(await readFile(path, 'utf8')).toBe('new')
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    expect(await readdir(join(root, 'LaunchAgents'))).toEqual(['agent.plist'])
    await removeLaunchAgent(path)
    await removeLaunchAgent(path)
  })
  it('whitelists state, pid and exit code, not environment or malformed lines', () => {
    expect(
      launchdStatusLines(
        '  state = running\n\tpid = 123\n last exit code = 78\nPATH = secret\nstate = SECRET=bad\npid = 1 secret\npid = 12345678901\nlast exit code = -1',
      ),
    ).toEqual(['state = running', 'pid = 123', 'last exit code = 78'])
  })
  it('recognizes only measured missing-job codes', () => {
    for (const command of ['bootout', 'print', 'kickstart'] as const)
      for (const code of [0, 1, 3, 113, null])
        expect(launchctlMissing(command, code)).toBe(code === (command === 'bootout' ? 3 : 113))
  })
  it.each([64, 69, 77, 78, 0, 70, 75, 130, 143])(
    'maps only permanent exit %s and records at 0600',
    async (code) => {
      const result = await launchdExit(code, {}, root, 1000)
      const path = serviceExitPath({}, root)
      if ([64, 69, 77, 78].includes(code)) {
        expect(result).toBe(0)
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
          code,
          at: '1970-01-01T00:00:01.000Z',
        })
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect(await readServiceExit(path)).toBe(permanentServiceReason(code))
      } else {
        expect(result).toBe(code)
        await expect(stat(path)).rejects.toThrow()
      }
    },
  )
  it('clears a stale exit record and trims stderr only beyond 1 MiB to the last 256 KiB', async () => {
    const path = join(hostLogDirectory({}, root), 'launchd.err.log')
    await launchdExit(78, {}, root, 1000)
    await mkdir(hostLogDirectory({}, root), { recursive: true })
    await writeFile(path, 'a'.repeat(1024 * 1024))
    await prepareLaunchdRun({}, root)
    expect((await stat(path)).size).toBe(1024 * 1024)
    await expect(stat(serviceExitPath({}, root))).rejects.toThrow()
    await writeFile(path, 'a'.repeat(1024 * 1024 - 256 * 1024 + 1) + 'b'.repeat(256 * 1024))
    await prepareLaunchdRun({}, root)
    expect(await readFile(path, 'utf8')).toBe('b'.repeat(256 * 1024))
    await removeLaunchAgent(path)
    await prepareLaunchdRun({}, root)
  })
  it('bounds log reads and ignores malformed, oversize or non-permanent records', async () => {
    const path = join(root, 'file')
    await writeFile(path, Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join(''))
    expect((await readLogTail(path, 200)).text.split('\n')).toHaveLength(200)
    expect((await readLogTail(path, 50, 20)).text).toBe('line 298\nline 299')
    await writeFile(path, 'x'.repeat(1024 * 1024))
    expect((await readLogTail(path, 200)).text.length).toBeLessThanOrEqual(256 * 1024)
    for (const text of [
      '{',
      'null',
      '{"code":75,"at":"2026-01-01"}',
      '{"code":78}',
      '{"code":78,"at":"bad"}',
      ' '.repeat(1025),
    ]) {
      await writeFile(path, text)
      expect(await readServiceExit(path)).toBeUndefined()
    }
    const record = JSON.stringify({ code: 78, at: '2026-01-01T00:00:00.000Z' })
    await writeFile(path, record.padEnd(1024))
    expect(await readServiceExit(path)).toBe('config invalid')
    await writeFile(path, record.padEnd(1025))
    expect(await readServiceExit(path)).toBeUndefined()
    await removeLaunchAgent(path)
    expect(await readServiceExit(path)).toBeUndefined()
  })
})
