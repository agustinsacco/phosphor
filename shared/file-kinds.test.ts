import { describe, expect, it } from 'vitest'
import { extensionOf, isTextPreview, mimeTypeForPath, previewKindForPath } from './file-kinds'

describe('previewKindForPath', () => {
  it.each([
    ['/w/photo.PNG', 'image'],
    ['/w/logo.svg', 'image'],
    ['/w/clip.mov', 'video'],
    ['/w/talk.webm', 'video'],
    ['/w/voice.m4a', 'audio'],
    ['/w/RQ007298_MedEx.pdf', 'pdf'],
    ['/w/report.html', 'html'],
    ['C:\\w\\report.HTM', 'html'],
    ['/w/notes.txt', null],
    ['/w/app.ts', null],
    ['/w/report.docx', null],
    ['/w/.png', null], // a hidden file, not a PNG
    ['/w/pdf', null],
    ['/w/dir.pdf/file', null],
  ])('%s → %s', (path, kind) => {
    expect(previewKindForPath(path)).toBe(kind)
  })
})

describe('isTextPreview', () => {
  it('keeps a source view only for formats that are text', () => {
    expect(isTextPreview('/w/a.html')).toBe(true)
    expect(isTextPreview('/w/a.svg')).toBe(true)
    expect(isTextPreview('/w/a.png')).toBe(false)
    expect(isTextPreview('/w/a.pdf')).toBe(false)
  })
})

describe('mimeTypeForPath', () => {
  it('forces a type from the extension, opaque bytes when unknown', () => {
    expect(mimeTypeForPath('/w/doc.pdf')).toBe('application/pdf')
    expect(mimeTypeForPath('/w/site/app.css')).toBe('text/css; charset=utf-8')
    expect(mimeTypeForPath('/w/.env')).toBe('application/octet-stream')
    expect(mimeTypeForPath('/w/Makefile')).toBe('application/octet-stream')
  })
})

describe('extensionOf', () => {
  it('reads the last extension of the last segment', () => {
    expect(extensionOf('/w/archive.tar.GZ')).toBe('gz')
    expect(extensionOf('/w.d/README')).toBe('')
    expect(extensionOf('/w/.env')).toBe('')
  })
})
