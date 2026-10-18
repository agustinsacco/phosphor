import { describe, expect, it } from 'vitest'
import { parseClientFrame } from '../host-protocol'

const REQUEST = '00000000-0000-4000-8000-000000000003'
const IMAGE = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
const command = (op: unknown) =>
  parseClientFrame(JSON.stringify({ type: 'command', requestId: REQUEST, op }))
const prompt = (images: unknown) => command({ type: 'prompt', message: 'm', images })
const answer = (response: unknown) => command({ type: 'extension_ui_response', response })
const REFUSED = {
  ok: false,
  reason: 'command',
  reply: { kind: 'receipt', requestId: REQUEST, code: 'bad-request' },
}

// Characterization through the public entry, before images and UI responses move out.
describe('prompt images and UI responses through the public entry', () => {
  it('allows zero to sixteen images and projects each to its three fields', () => {
    for (const n of [0, 1, 16])
      expect(prompt(Array.from({ length: n }, () => ({ ...IMAGE, x: 1 })))).toStrictEqual({
        ok: true,
        frame: {
          type: 'command',
          requestId: REQUEST,
          op: { type: 'prompt', message: 'm', images: Array.from({ length: n }, () => IMAGE) },
        },
      })
    for (const images of [Array.from({ length: 17 }, () => IMAGE), {}, 'AAAA', null])
      expect(prompt(images)).toStrictEqual(REFUSED)
  })

  it('takes base64 of a multiple of four with at most two padding characters', () => {
    for (const data of ['AAAA', 'AA==', 'AAA=', 'A+/9', 'AAAA'.repeat(1000) + 'AA=='])
      expect(prompt([{ ...IMAGE, data }]).ok, data).toBe(true)
    for (const data of [
      '',
      'A',
      'AA',
      'AAA',
      'AA=',
      'A===',
      '====',
      'AA=A',
      'AA AA',
      'AAA-',
      'AAA_',
    ])
      expect(prompt([{ ...IMAGE, data }]), data).toStrictEqual(REFUSED)
    expect(prompt([{ ...IMAGE, data: 'AA==AAAA' }])).toStrictEqual(REFUSED)
  })

  it('allows only the four image mime types', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
      expect(prompt([{ ...IMAGE, mimeType }]).ok, mimeType).toBe(true)
    for (const mimeType of ['image/svg+xml', 'IMAGE/PNG', 'image/jpg', '', undefined])
      expect(prompt([{ ...IMAGE, mimeType }]), String(mimeType)).toStrictEqual(REFUSED)
    expect(prompt([{ ...IMAGE, type: 'text' }])).toStrictEqual(REFUSED)
  })

  it('needs exactly one UI answer: a string value, a boolean confirmation or cancelled true', () => {
    const base = { type: 'extension_ui_response', id: 'dialog' }
    for (const fields of [
      { value: '' },
      { value: 'x'.repeat(1000) },
      { confirmed: true },
      { confirmed: false },
      { cancelled: true },
    ])
      expect(answer({ ...base, ...fields, x: 1 })).toStrictEqual({
        ok: true,
        frame: {
          type: 'command',
          requestId: REQUEST,
          op: { type: base.type, response: { ...base, ...fields } },
        },
      })
    for (const fields of [
      {},
      { value: null },
      { confirmed: 'yes' },
      { cancelled: false },
      { value: 'a', cancelled: true },
      { confirmed: true, cancelled: true },
      { value: 'a', confirmed: false, cancelled: true },
    ])
      expect(answer({ ...base, ...fields }), JSON.stringify(fields)).toStrictEqual(REFUSED)
    for (const response of [
      null,
      [],
      { ...base, type: 'extension_ui_request', value: 'a' },
      { ...base, id: 'a.b', value: 'a' },
    ])
      expect(answer(response)).toStrictEqual(REFUSED)
  })
})
