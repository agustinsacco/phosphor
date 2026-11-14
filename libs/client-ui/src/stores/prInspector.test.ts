import { beforeEach, expect, it } from 'vitest'
import { PR_INSPECTOR_REQUEST_MS, usePrInspectorStore } from './prInspector'

beforeEach(() => usePrInspectorStore.setState({ request: null }))

it('hands a request to its own lane once', () => {
  usePrInspectorStore.getState().open('a', 'github.com/o/r#5')
  expect(usePrInspectorStore.getState().take('b')).toBeNull()
  expect(usePrInspectorStore.getState().take('a')).toMatchObject({ key: 'github.com/o/r#5' })
  expect(usePrInspectorStore.getState().take('a')).toBeNull()
})

it('drops a request no pill answered in time', () => {
  usePrInspectorStore.getState().open('a')
  const at = usePrInspectorStore.getState().request!.at
  expect(usePrInspectorStore.getState().take('a', at + PR_INSPECTOR_REQUEST_MS + 1)).toBeNull()
  expect(usePrInspectorStore.getState().request).toBeNull()
})
