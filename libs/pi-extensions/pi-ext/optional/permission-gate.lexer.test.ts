import { describe, expect, it } from 'vitest'
import { lex } from './permission-gate'

const word = (text: string, dynamic = false) => ({ text, dynamic })
const parse = (source: string) => lex(source, 0, false, 0)

describe('permission-gate lexer state', () => {
  it('joins quoted fragments, retains empty words and distinguishes literal expansions', () => {
    const source =
      'echo pre"two words"\' tail\' "" \'$literal\' "$value" $plain "\\$escaped" a\\ b \\\nend # comment\nprintf ok'
    expect(parse(source)).toEqual({
      end: source.length,
      commands: [
        [
          word('echo'),
          word('pretwo words tail'),
          word(''),
          word('$literal'),
          word('$value', true),
          word('$plain', true),
          word('$escaped'),
          word('a b'),
          word('end'),
        ],
        [word('printf'), word('ok')],
      ],
      scripts: [],
    })
  })

  it('discards redirect targets and file descriptors without losing following words', () => {
    const source = 'echo keep >out tail 2>>err &>>both <input last; cat 3<&0 >|output'
    expect(parse(source)).toEqual({
      end: source.length,
      commands: [[word('echo'), word('keep'), word('tail'), word('last')], [word('cat')]],
      scripts: [],
    })
  })

  it('resets herestring and line state, forwarding stdin only on shell-reading lines', () => {
    const source = 'bash <<< "echo one"; printf tail >out\ncat <<< "sudo id"\nprintf end'
    expect(parse(source)).toEqual({
      end: source.length,
      commands: [
        [word('bash')],
        [word('printf'), word('tail')],
        [word('cat')],
        [word('printf'), word('end')],
      ],
      scripts: ['echo one'],
    })
  })

  it.each(['E\\OF', 'E"OF"', "E'OF'"])(
    'removes delimiter quoting in %s and suppresses body expansion',
    (delimiter) => {
      const source = `cat <<${delimiter}\n$(sudo id)\nEOF\necho tail`
      expect(parse(source)).toEqual({
        end: source.length,
        commands: [[word('cat')], [word('echo'), word('tail')]],
        scripts: [],
      })
    },
  )

  it('consumes queued heredocs in order and strips tabs only for delimiter matching', () => {
    const source = "bash <<-'A' <<B\n\techo literal\n\tA\n$(sudo id)\nB\nprintf tail"
    expect(parse(source)).toEqual({
      end: source.length,
      commands: [[word('bash')], [word('sudo'), word('id')], [word('printf'), word('tail')]],
      scripts: ['\techo literal\n', '$(sudo id)\n'],
    })
  })

  it('merges nested commands before the outer word while preserving its dynamic source', () => {
    const source = 'echo "$(printf $(sudo id))"tail $((1 + $(shred x)))'
    expect(parse(source)).toEqual({
      end: source.length,
      commands: [
        [word('sudo'), word('id')],
        [word('printf'), word('$(sudo id)', true)],
        [word('shred'), word('x')],
        [word('echo'), word('$(printf $(sudo id))tail', true), word('$((1 + $(shred x)))', true)],
      ],
      scripts: [],
    })
  })

  it('records backticks separately and treats process substitutions as dynamic words', () => {
    const source = 'echo `sudo id` <(shred x) >(truncate x)'
    expect(parse(source)).toEqual({
      end: source.length,
      commands: [
        [word('shred'), word('x')],
        [word('truncate'), word('x')],
        [
          word('echo'),
          word('`sudo id`', true),
          word('<(shred x)', true),
          word('>(truncate x)', true),
        ],
      ],
      scripts: ['sudo id'],
    })
    expect(parse('echo `echo \\`x\\` \\$HOME \\\\`').scripts).toEqual(['echo `x` $HOME \\'])
  })

  it('returns the offset after a nested close without consuming trailing source', () => {
    const source = 'prefix (sudo id; (shred x)) )tail'
    expect(lex(source, source.indexOf('('), true, 0)).toEqual({
      end: source.indexOf('tail'),
      commands: [
        [word('sudo'), word('id')],
        [word('shred'), word('x')],
      ],
      scripts: [],
    })
  })

  it.each(['echo "', "echo '", 'echo `x', 'echo $(', 'echo $((1)', 'cat <<', "cat <<'EOF"])(
    'throws on malformed syntax: %s',
    (source) => {
      expect(() => parse(source)).toThrow()
    },
  )

  it('rejects unclosed nested source and pending heredocs at its closing paren', () => {
    expect(() => lex('sudo id', 0, true, 0)).toThrow()
    expect(() => lex('cat <<EOF)', 0, true, 0)).toThrow()
  })

  it('allows depth eight but refuses deeper entry and substitutions', () => {
    expect(lex('sudo id', 0, false, 8).commands).toEqual([[word('sudo'), word('id')]])
    expect(() => lex('sudo id', 0, false, 9)).toThrow()
    expect(() => lex('echo $(sudo id)', 0, false, 8)).toThrow()
    expect(lex('echo $(sudo id)', 0, false, 7).commands[0]).toEqual([word('sudo'), word('id')])
    expect(() => lex('cat <<EOF\n$(sudo id)\nEOF', 0, false, 8)).toThrow()
  })
})
