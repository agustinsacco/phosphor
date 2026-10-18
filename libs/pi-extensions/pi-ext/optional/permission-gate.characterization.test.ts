import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { permissionDecision, permissionFindings } from './permission-gate'

describe('permission-gate public lexer characterization', () => {
  it.each([
    ["cat <<'EOF'\nsudo rm -rf /\nEOF", []],
    ['cat <<EOF\n$(sudo id)\nEOF', ['sudo']],
    ["cat <<'EOF' | bash\nsudo id\nEOF", ['sudo']],
    ['bash <<-EOF\n\tsudo id\n\tEOF', ['sudo']],
    ['cat <<A <<B\n$(sudo id)\nA\n`shred x`\nB', ['sudo', 'shred']],
    ['bash <<< "sudo id"', ['sudo']],
    ['echo "sudo rm -rf /"; grep \'truncate\' file # shred', []],
    ['echo "$(sudo id)" `shred x` <(truncate x)', ['sudo', 'truncate', 'shred']],
    ['echo $(( $(sudo id) + 1 ))', ['sudo']],
    ['env X=1 nohup timeout 5 /bin/rm -rf /important', ['rm -r']],
    ['command -v sudo; command -- sudo id', ['sudo']],
    ["ssh host 'sudo id'; find . -exec shred {} \\;", ['sudo', 'shred']],
    ["trap 'sudo id' EXIT; eval 'truncate x'", ['sudo', 'truncate']],
    ['sudo id; sudo true; shred x', ['sudo', 'shred']],
    ['echo "unterminated; sudo id; rm -rf /important', ['rm -r', 'sudo']],
    ['echo "$(unterminated', []],
    [`echo ${'$('.repeat(10)}echo sudo${')'.repeat(10)}`, ['sudo']],
    ['echo "\\$x"; echo \'$(sudo id)\'', []],
  ] as const)('pins findings and decision for %s', (command, findings) => {
    expect(permissionFindings(command)).toEqual(findings)
    expect(permissionDecision(command)).toBe(findings.length ? 'ask' : 'allow')
  })
})

describe('permission-gate public lane characterization', () => {
  let root: string
  let lane: string
  let main: string
  let home: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'permission-characterization-')))
    main = join(root, 'main')
    lane = join(root, 'lane')
    home = join(root, 'home')
    mkdirSync(main)
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', [
      '-C',
      main,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
      '--allow-empty',
    ])
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'lane', lane])
    mkdirSync(join(lane, 'src'))
    symlinkSync(main, join(lane, 'escape'))
    symlinkSync(join(lane, 'src'), join(lane, 'internal'))
    symlinkSync(join(root, 'absent'), join(lane, 'dangling'))
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  afterEach(() => vi.unstubAllEnvs())

  it('resolves symlinks and missing ancestors for every rm target', () => {
    for (const command of [
      'rm -rf src missing/deep internal/new',
      'rm --recursive -- src missing/deep',
      `rm -rf '${lane}/src'`,
    ])
      expect(permissionFindings(command, lane), command).toEqual([])
    for (const command of [
      'rm -rf src /important',
      'rm -rf escape/new',
      'rm -rf dangling/new',
      'rm -rf .',
      'rm -rf src/../missing',
      'rm -rf "$target"',
      'rm -rf src/*',
    ])
      expect(permissionDecision(command, lane), command).toBe('ask')
    expect(permissionDecision('rm -rf missing/deep', main)).toBe('ask')
  })

  it('invalidates relative targets after cwd changes and all targets after path mutation', () => {
    expect(permissionFindings(`cd '${lane}'; rm -rf src`, lane)).toEqual([])
    expect(permissionFindings(`cd /; rm -rf '${lane}/src'`, lane)).toEqual([])
    for (const command of [
      'cd /; rm -rf src',
      '(cd /); rm -rf src',
      'env -C / rm -rf src',
      "bash -c 'ln -s /important link'; rm -rf src",
      'mv escape new; rm -rf src',
      "eval 'true'; rm -rf src",
      "trap 'rm -rf src' EXIT",
      'echo src | xargs rm -rf',
    ])
      expect(permissionFindings(command, lane), command).toEqual(['rm -r'])
  })

  it('rereads the user lane exemption without exempting other findings', () => {
    vi.stubEnv('HOME', home)
    const config = join(home, '.pi', 'agent', 'permission-gate.json')
    writeFileSync(config, JSON.stringify({ unguardedDeleteLanes: [lane] }))
    expect(permissionFindings('rm -rf /important "$target"; sudo id', lane)).toEqual(['sudo'])
    expect(permissionDecision('rm -rf /important', main)).toBe('ask')
    writeFileSync(config, JSON.stringify({ unguardedDeleteLanes: [] }))
    expect(permissionDecision('rm -rf /important', lane)).toBe('ask')
    writeFileSync(config, 'invalid')
    expect(permissionDecision('rm -rf /important', lane)).toBe('ask')
  })
})
