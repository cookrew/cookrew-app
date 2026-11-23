// THE SHEET THAT SHOWS AN ARTIFACT ON THE PHONE OR CONSOLE (artifact/ArtifactSheet.tsx).
// House pattern: no jsdom, renderToStaticMarkup over the presentational half;
// the container's fetch and object URL are effects and stay out of it.
import { readdirSync, readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArtifactSheetView, type SheetState } from '../src/renderer/src/artifact/ArtifactSheet'
import { showOf, type ArtifactPayload } from '../src/renderer/src/artifact/artifact-decode'

const URL_ = 'blob:https://phone.local/1111'
const ready = (payload: ArtifactPayload, over: Partial<Extract<SheetState, { phase: 'ready' }>> = {}): SheetState => ({
  phase: 'ready',
  payload,
  show: showOf(payload),
  objectUrl: payload.kind === 'note' || payload.kind === 'file' ? URL_ : null,
  saveName: payload.kind === 'file' ? payload.name : `${payload.name}.md`,
  saved: false,
  ...over
})
const paint = (state: SheetState): string => renderToStaticMarkup(<ArtifactSheetView title="Card" state={state} onClose={() => undefined} onSave={() => undefined} />)
const file = (mime: string, body = '', name = 'f.bin'): ArtifactPayload => ({ kind: 'file', name, mime, hash: 'a'.repeat(64), bytes: new TextEncoder().encode(body).buffer as ArrayBuffer })
const iframes = (html: string): string[] => html.match(/<iframe[^>]*>/g) ?? []

describe('a note', () => {
  const html = paint(ready({ kind: 'note', name: 'Plan', title: 'The plan', markdown: '# The plan\n\nship **it**' }))

  it('is a dialog with its title and a close button', () => {
    expect(html).toContain('role="dialog"')
    expect(html).toContain('The plan')
    expect(html).toMatch(/aria-label="Close"/)
  })

  it('is drawn in an iframe sandboxed to scripts alone, never the console origin', () => {
    const [frame] = iframes(html)
    expect(frame).toContain('sandbox="allow-scripts"')
    expect(frame).not.toContain('allow-same-origin')
    // The frame is a blob of the document, not srcdoc: a srcdoc frame inherits the
    // console's CSP, which allows no inline script there.
    expect(frame).toMatch(new RegExp(` src="${URL_}"`))
    expect(frame).not.toMatch(/ srcdoc="/i)
    // The document itself is not inlined here: it lives in the blob the frame points at.
    expect(html).not.toContain('&lt;strong&gt;it&lt;/strong&gt;')
  })

  it('offers to save it, as markdown', () => {
    expect(html).toContain(`href="${URL_}"`)
    expect(html).toContain('download="Plan.md"')
    expect(html).toContain('Save to this device')
    expect(html).not.toContain('Saved on this device')
  })

  it('says when a copy is kept here', () => {
    expect(paint(ready({ kind: 'note', name: 'Plan', title: 'T', markdown: 'x' }, { saved: true }))).toContain('Saved on this device')
  })
})

describe('a file', () => {
  it('HTML is its own page in the same sandbox, scripts but no origin', () => {
    const html = paint(ready(file('text/html', '<p>report</p>', 'report.html')))
    const [frame] = iframes(html)
    expect(frame).toContain('sandbox="allow-scripts"')
    expect(frame).not.toContain('allow-same-origin')
    expect(html).toContain('download="report.html"')
  })

  it('an image is an img from its object URL', () => {
    const html = paint(ready(file('image/png', '', 'chart.png')))
    expect(html).toMatch(new RegExp(`<img[^>]*src="${URL_}"`))
    expect(iframes(html)).toHaveLength(0)
  })

  it('a PDF is a frame from its object URL (the console allows no object-src)', () => {
    const html = paint(ready(file('application/pdf', '', 'a.pdf')))
    expect(html).toMatch(new RegExp(`<iframe[^>]*src="${URL_}"`))
    expect(html).not.toMatch(/<object/)
  })

  it('anything else is only a way to save it', () => {
    const html = paint(ready(file('application/zip', '', 'a.zip')))
    expect(html).toContain('download="a.zip"')
    expect(html).not.toMatch(/<iframe|<img|<object/)
  })
})

describe('a link and a refusal', () => {
  it('a link is an anchor the phone opens itself, and nothing to save', () => {
    const html = paint(ready({ kind: 'link', name: 'Docs', url: 'https://example.com/docs' }))
    expect(html).toMatch(/<a[^>]*href="https:\/\/example.com\/docs"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
    expect(html).not.toContain('Save to this device')
  })

  it('a refusal reads out its why and offers nothing', () => {
    const html = paint(ready({ kind: 'unavailable', name: 'x', why: 'That file is no longer on the computer that made it.' }))
    expect(html).toContain('That file is no longer on the computer that made it.')
    expect(html).not.toContain('Save to this device')
    expect(html).not.toMatch(/<iframe/)
  })

  it('loading and failure have words of their own', () => {
    expect(paint({ phase: 'loading' })).toMatch(/Loading/)
    expect(paint({ phase: 'failed', why: 'No such card.' })).toContain('No such card.')
  })
})

describe('source rules', () => {
  const dir = new URL('../src/renderer/src/artifact/', import.meta.url)
  const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const)

  it('the viewer never writes HTML into the console document', () => {
    expect(sources.length).toBeGreaterThan(0)
    for (const [, src] of sources) {
      expect(src).not.toMatch(/\.innerHTML\s*=|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write/)
    }
  })

  it('never grants a frame the console origin', () => {
    for (const [, src] of sources) expect(src).not.toMatch(/allow-same-origin/)
  })

  it('gives a frame an address of its own, never srcdoc', () => {
    // srcdoc inherits the console page's CSP (script-src 'self'), so an artifact
    // with inline script would render blank there. A blob frame does not.
    const sheet = sources.find(([name]) => name === 'ArtifactSheet.tsx')
    expect(sheet).toBeDefined()
    expect(sheet![1]).not.toMatch(/srcDoc=/)
    expect(sheet![1]).toMatch(/new Blob\(\[show\.srcdoc\]/)
  })

  it('the bar item card offers Open here on the phone and console only', () => {
    const cards = readFileSync(new URL('../src/renderer/src/zoom/BarCards.tsx', import.meta.url), 'utf8')
    expect(cards).toMatch(/isRemoteMode\(\)\s*&&[\s\S]{0,400}openArtifact\(/)
    const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('<ArtifactSheetHost />')
  })
})
