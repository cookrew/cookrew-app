import { readdirSync, readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FilesSheetView, type FilesListingState } from '../src/renderer/src/artifact/FilesSheet'
import { filesSheet } from '../src/renderer/src/artifact/open-files'
import { ArtifactSheetView } from '../src/renderer/src/artifact/ArtifactSheet'

const root = { path: '/shared/Projects', name: 'Projects' }
const noop = (): void => undefined
const paint = (location: Parameters<typeof FilesSheetView>[0]['location'], state: FilesListingState): string =>
  renderToStaticMarkup(<FilesSheetView location={location} state={state} onBack={noop} onClose={noop} onOpen={noop} />)

describe('Files sheet', () => {
  it('lists the computer’s shared roots by name', () => {
    const html = paint({ kind: 'roots' }, { phase: 'roots', roots: [root, { path: '/home/Documents', name: 'Documents' }] })
    expect(html).toContain('aria-label="Files"')
    expect(html).toMatch(/<button[^>]*>Projects<\/button>/)
    expect(html).toMatch(/<button[^>]*>Documents<\/button>/)
  })

  it('shows the path and puts folders before files', () => {
    const html = paint({ kind: 'folder', root, folders: ['Reports'] }, {
      phase: 'folder',
      entries: [
        { name: 'a.pdf', kind: 'file', size: 12, mtimeMs: 0 },
        { name: 'Yearly', kind: 'dir', size: 0, mtimeMs: 0 },
        { name: '<pipe>', kind: 'other', size: 0, mtimeMs: 0 }
      ],
      truncated: true
    })
    expect(html).toContain('aria-label="Folder path"')
    expect(html).toContain('aria-current="page">Reports')
    expect(html).toMatch(/Projects[\s\S]*Reports[\s\S]*Yearly[\s\S]*a\.pdf/)
    expect(html).toContain('&lt;pipe&gt;')
    expect(html).toContain('Only part of this folder is shown')
  })

  it('shows the server’s reason for a refusal', () => {
    const html = paint({ kind: 'folder', root, folders: [] }, { phase: 'failed', why: 'That folder is no longer shared.' })
    expect(html).toContain('That folder is no longer shared.')
    expect(html).toContain('aria-label="Back"')
  })

  it('a failed listing offers to try again', () => {
    const html = renderToStaticMarkup(
      <FilesSheetView location={{ kind: 'roots' }} state={{ phase: 'failed', why: 'Nope.' }} onBack={noop} onClose={noop} onOpen={noop} onRetry={noop} />
    )
    expect(html).toContain('Nope.')
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/)
  })

  it('Save hands over the original bytes, not the generated preview page', () => {
    const html = renderToStaticMarkup(
      <ArtifactSheetView
        title="notes.md"
        onClose={noop}
        onSave={noop}
        state={{ phase: 'ready', payload: { kind: 'file' }, show: { as: 'frame' }, objectUrl: 'blob:https://p/preview', downloadUrl: 'blob:https://p/original', saveName: 'notes.md', saved: false }}
      />
    )
    expect(html).toMatch(/<iframe[^>]*src="blob:https:\/\/p\/preview"/)
    expect(html).toMatch(/<a[^>]*href="blob:https:\/\/p\/original"[^>]*download="notes.md"/)
  })

  it('backs out of a file, each parent folder, and finally the sheet', () => {
    filesSheet.open()
    filesSheet.go({ kind: 'file', root, folders: ['Reports'], name: 'a.pdf' })
    try {
      for (const expected of [
        { kind: 'folder', root, folders: ['Reports'] },
        { kind: 'folder', root, folders: [] },
        { kind: 'roots' },
        null
      ]) {
        filesSheet.back()
        expect(filesSheet.get()).toEqual(expected)
      }
    } finally {
      filesSheet.close()
    }
  })

  it('keeps Files out of the host document and uses the shared preview', () => {
    const dir = new URL('../src/renderer/src/artifact/', import.meta.url)
    const sources = readdirSync(dir).filter((name) => /files.*\.tsx?$/i.test(name))
    expect(sources).toContain('FilesSheet.tsx')
    for (const name of sources) {
      expect(readFileSync(new URL(name, dir), 'utf8')).not.toMatch(/innerHTML|dangerouslySetInnerHTML|allow-same-origin|srcDoc\s*=/i)
    }
    expect(readFileSync(new URL('FilesSheet.tsx', dir), 'utf8')).toContain('<ArtifactSheetView')
  })

  it('mounts from App and opens beside Open here on remote cards', () => {
    const renderer = new URL('../src/renderer/src/', import.meta.url)
    const cards = readFileSync(new URL('zoom/BarCards.tsx', renderer), 'utf8')
    expect(cards).toMatch(/isRemoteMode\(\)\s*&&[\s\S]*?OPEN HERE[\s\S]*?filesSheet\.open\(\)/)
    expect(readFileSync(new URL('App.tsx', renderer), 'utf8')).toContain('<FilesSheetHost />')
  })
})
