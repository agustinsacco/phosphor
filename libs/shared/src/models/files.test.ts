import { expectTypeOf, it } from 'vitest'
import type { FileContent, OpenInDefaultAppResult } from './files'

it('files keeps optional nullable revisions and open-app refusal variants', () => {
  expectTypeOf<FileContent['revision']>().toEqualTypeOf<string | null | undefined>()
  expectTypeOf<Pick<FileContent, 'revision'>>().toEqualTypeOf<{ revision?: string | null }>()
  expectTypeOf<OpenInDefaultAppResult>().toEqualTypeOf<
    | { ok: true }
    | { ok: false; reason: 'launchable' }
    | { ok: false; reason: 'not-a-file' }
    | { ok: false; reason: 'failed'; message: string }
  >()
})
