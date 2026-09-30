import { afterEach, describe, expect, it } from 'vitest'
import { activeAgent, setActiveAgent } from './agent'

afterEach(() => setActiveAgent(undefined))

describe('agent selection', () => {
  it('is pi with no binary override until something else is stored', () => {
    expect(activeAgent()).toEqual({ kind: 'pi', binaryPaths: { pi: '', omp: '' } })
  })

  it('takes the stored agent and trims each binary path', () => {
    expect(setActiveAgent({ kind: 'omp', binaryPaths: { omp: '  /opt/omp  ' } })).toEqual({
      kind: 'omp',
      binaryPaths: { pi: '', omp: '/opt/omp' },
    })
    expect(activeAgent().kind).toBe('omp')
  })

  it('reads a hand-edited unknown agent or malformed paths as the pi default', () => {
    expect(setActiveAgent({ kind: 'claude', binaryPaths: { pi: 42, omp: null } })).toEqual({
      kind: 'pi',
      binaryPaths: { pi: '', omp: '' },
    })
    expect(setActiveAgent('omp')).toEqual({ kind: 'pi', binaryPaths: { pi: '', omp: '' } })
  })

  it('keeps each agent its own path, so switching never runs one as the other', () => {
    const both = { pi: '/bin/pi', omp: '/bin/omp' }
    expect(setActiveAgent({ kind: 'omp', binaryPaths: both }).binaryPaths).toEqual(both)
    expect(setActiveAgent({ kind: 'pi', binaryPaths: both }).binaryPaths).toEqual(both)
  })
})
