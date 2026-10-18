import { expect, expectTypeOf, it } from 'vitest'
import type { ExtensionUIRequest, ExtensionUIResponse } from './extension-ui'

it('preserves timed dialogs and the untimed editor contract', () => {
  expectTypeOf<Extract<ExtensionUIRequest, { method: 'select' }>>().toEqualTypeOf<{
    type: 'extension_ui_request'
    id: string
    method: 'select'
    title: string
    options: string[]
    timeout?: number
  }>()
  expectTypeOf<Extract<ExtensionUIRequest, { method: 'confirm' }>>().toEqualTypeOf<{
    type: 'extension_ui_request'
    id: string
    method: 'confirm'
    title: string
    message: string
    timeout?: number
  }>()
  expectTypeOf<Extract<ExtensionUIRequest, { method: 'input' }>>().toEqualTypeOf<{
    type: 'extension_ui_request'
    id: string
    method: 'input'
    title: string
    placeholder?: string
    timeout?: number
  }>()
  expectTypeOf<Extract<ExtensionUIRequest, { method: 'editor' }>>().toEqualTypeOf<{
    type: 'extension_ui_request'
    id: string
    method: 'editor'
    title: string
    prefill?: string
  }>()
})

it('preserves clearable status and widget state', () => {
  expectTypeOf<Extract<ExtensionUIRequest, { method: 'setStatus' }>>().toEqualTypeOf<{
    type: 'extension_ui_request'
    id: string
    method: 'setStatus'
    statusKey: string
    statusText: string | undefined
  }>()
  expectTypeOf<Extract<ExtensionUIRequest, { method: 'setWidget' }>>().toEqualTypeOf<{
    type: 'extension_ui_request'
    id: string
    method: 'setWidget'
    widgetKey: string
    widgetLines: string[] | undefined
    widgetPlacement?: 'aboveEditor' | 'belowEditor'
  }>()
})

it('keeps value, confirmation and cancellation replies distinct', () => {
  expectTypeOf<ExtensionUIResponse>().toEqualTypeOf<
    | { type: 'extension_ui_response'; id: string; value: string }
    | { type: 'extension_ui_response'; id: string; confirmed: boolean }
    | { type: 'extension_ui_response'; id: string; cancelled: true }
  >()
  const cancelled: ExtensionUIResponse = {
    type: 'extension_ui_response',
    id: 'dialog',
    cancelled: true,
  }
  expect(cancelled).toEqual({ type: 'extension_ui_response', id: 'dialog', cancelled: true })
})
