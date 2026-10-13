import { describe, expect, it } from 'vitest'
import { createPredictor } from './predictor'

describe('createPredictor', () => {
  describe('earlier prompts', () => {
    it('suggests the rest of an earlier prompt the line starts, newest first', () => {
      const p = createPredictor([
        'run the e2e suite and fix whatever breaks',
        'run the e2e suite on macOS only',
      ])
      expect(p.predict('run the e2e su')).toBe('ite on macOS only')
    })

    it('matches case-insensitively and continues in the earlier spelling', () => {
      const p = createPredictor(['Review the diff for bugs'])
      expect(p.predict('review the d')).toBe('iff for bugs')
    })

    it('stops at the end of the earlier sentence', () => {
      const p = createPredictor(['please ship it now. then update the docs'])
      expect(p.predict('please ship i')).toBe('t now.')
    })

    it('waits for twelve typed characters before offering a whole prompt', () => {
      const p = createPredictor(['okay then lets do it'])
      expect(p.predict('okay then l')).toBeNull()
      expect(p.predict('okay then le')).toBe('ts do it')
    })

    it('offers at most eight words of it', () => {
      const p = createPredictor(['please count one two three four five six seven eight nine'])
      expect(p.predict('please count ')).toBe('one two three four five six seven eight')
      expect(p.predict('please count')).toBe(' one two three four five six seven eight')
    })

    it('matches the current line of a multi-line draft, ignoring its indent', () => {
      const p = createPredictor(['first line here', 'second line there'])
      expect(p.predict('something else\n  second line th')).toBe('ere')
    })

    it('never suggests from inside a fenced code block', () => {
      const p = createPredictor(['look at this\n```\nconst answer = 42\n```'])
      expect(p.predict('const ans')).toBeNull()
    })
  })

  describe('next words', () => {
    const prompts = [
      'ok good lets open a PR',
      'ok good lets open a PR now',
      'ok good lets open a PR please',
      'please check the subagents tab',
      'restart the subagents',
      'what do subagents do',
    ]

    it('suggests the usual next words after a space', () => {
      expect(createPredictor(prompts).predict('so yes good lets ')).toBe('open a PR')
    })

    it('finishes the word being typed from its context', () => {
      expect(createPredictor(prompts).predict('so yes good lets op')).toBe('en a PR')
    })

    it('finishes a word from vocabulary alone after three letters', () => {
      const p = createPredictor(prompts)
      expect(p.predict('show me my subag')).toBe('ents')
      expect(p.predict('show me my sub')).toBe('agents')
      expect(p.predict('show me my su')).toBeNull()
    })

    it('keeps the typed letters and continues in the learned spelling', () => {
      expect(createPredictor(['Phosphor', 'Phosphor', 'Phosphor']).predict('about pho')).toBe(
        'sphor',
      )
    })

    it('shows nothing when a context went many ways', () => {
      const p = createPredictor(['then run x', 'then open y', 'then close z', 'then build w'])
      expect(p.predict('ok then ')).toBeNull()
    })

    it('needs a word seen twice after two words, three times after one', () => {
      const twice = ['so please deploy staging', 'so please deploy prod']
      expect(createPredictor(twice).predict('ok so please ')).toBe('deploy')
      expect(createPredictor(twice).predict('now please ')).toBeNull()
      expect(createPredictor([...twice, 'please deploy it']).predict('now please ')).toBe('deploy')
    })

    it('starts the context over after a sentence ends', () => {
      const p = createPredictor(['Done. Ship it', 'Great. Ship it', 'ok. Ship it'])
      expect(p.predict('Fine. Sh')).toBe('ip it')
    })

    it('does not run past the end of a sentence', () => {
      const p = createPredictor(Array(3).fill('merge it now. later'))
      expect(p.predict('please merge ')).toBe('it now.')
    })
  })

  it('learns prompts added later', () => {
    const p = createPredictor()
    expect(p.predict('deploy the w')).toBeNull()
    p.add('deploy the worker to staging')
    expect(p.predict('deploy the w')).toBe('orker to staging')
  })

  it('needs two typed characters on the line', () => {
    const p = createPredictor(['a', 'a', 'a'])
    expect(p.predict('')).toBeNull()
    expect(p.predict('x\n ')).toBeNull()
  })
})
