import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

/*
 * Tailwind draws `divide-y` in currentColor unless a divide colour is set, so a
 * list without `divide-border` shows near-black rules between its rows.
 */
it('draws every Settings list divider in the border colour (regression)', () => {
  const root = resolve(__dirname)
  const offenders = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.tsx') && !path.includes('.test.'))
    .flatMap((path) =>
      readFileSync(resolve(root, path), 'utf8')
        .split('\n')
        .map((line, index) => ({ line, at: `${path}:${index + 1}` }))
        .filter(({ line }) => /\bdivide-y\b/.test(line) && !/\bdivide-border\b/.test(line))
        .map(({ at }) => at),
    )
  expect(offenders).toEqual([])
})
