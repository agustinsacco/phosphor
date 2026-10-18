import { describe, expect, it } from 'vitest'
import { EXIT, exitCodeFor, fail, info, pass, warn, type Check } from './checks'

describe('Host check constructors', () => {
  it('builds each status with its id and summary', () => {
    expect(pass('node', 'node 22.19.0')).toEqual({
      id: 'node',
      status: 'pass',
      summary: 'node 22.19.0',
    })
    expect(warn('git', 'git is old')).toEqual({ id: 'git', status: 'warn', summary: 'git is old' })
    expect(info('home', '/home/tester')).toEqual({
      id: 'home',
      status: 'info',
      summary: '/home/tester',
    })
  })

  it('maps a failure to unavailable (69) unless it names config (78)', () => {
    expect(fail('pi', 'pi is missing')).toEqual({
      id: 'pi',
      status: 'fail',
      summary: 'pi is missing',
      exit: 69,
    })
    expect(fail('config', 'bad config', EXIT.config)).toEqual({
      id: 'config',
      status: 'fail',
      summary: 'bad config',
      exit: 78,
    })
  })

  it('uses the sysexits(3) numbers', () => {
    expect(EXIT).toEqual({
      ok: 0,
      usage: 64,
      unavailable: 69,
      internal: 70,
      tempfail: 75,
      noperm: 77,
      config: 78,
    })
  })
})

describe('exitCodeFor', () => {
  it('exits 0 with no checks', () => {
    expect(exitCodeFor([])).toBe(0)
  })

  it('exits 0 when every check passes, warns or informs', () => {
    expect(exitCodeFor([pass('node', 'ok'), warn('git', 'old'), info('home', '/home')])).toBe(0)
  })

  it('ignores an exit code carried by a check that did not fail', () => {
    const checks: Check[] = [
      { id: 'git', status: 'warn', summary: 'old', exit: EXIT.config },
      { id: 'home', status: 'info', summary: '/home', exit: EXIT.unavailable },
      { id: 'node', status: 'pass', summary: 'ok', exit: EXIT.config },
    ]
    expect(exitCodeFor(checks)).toBe(0)
  })

  it('exits 69 for a missing prerequisite among passing checks', () => {
    expect(exitCodeFor([pass('node', 'ok'), fail('pi', 'missing'), warn('git', 'old')])).toBe(69)
  })

  it('exits 69 for a failure that carries no exit code', () => {
    expect(exitCodeFor([{ id: 'pi', status: 'fail', summary: 'missing' }])).toBe(69)
  })

  it('exits 78 for a config failure alone', () => {
    expect(exitCodeFor([fail('config', 'bad', EXIT.config)])).toBe(78)
  })

  it.each([
    ['config first', [fail('config', 'bad', EXIT.config), fail('pi', 'missing')]],
    ['config last', [fail('pi', 'missing'), fail('config', 'bad', EXIT.config)]],
    [
      'config between',
      [fail('pi', 'missing'), fail('config', 'bad', EXIT.config), fail('git', 'missing')],
    ],
  ] as const)('a config failure (78) outranks unavailable (69) with %s', (_, checks) => {
    expect(exitCodeFor(checks)).toBe(78)
  })
})
