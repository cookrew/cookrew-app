// THE DEVICE'S READING OF /api/artifact/<id> (renderer/src/artifact/artifact-decode.ts).
// The route answers a JSON envelope for a note, a link or a refusal, and RAW
// BYTES for a file card. Both a file and an envelope can be application/json
// (a .json file is one), and across origins the name and ETag headers may not
// be readable at all (companion-cors.ts exposes none; the relay passes the
// ETag but not x-cookrew-artifact). The reading must hold in all of those.
import { describe, expect, it } from 'vitest'
import { decodeArtifactResponse, showOf, type ArtifactPayload } from '../src/renderer/src/artifact/artifact-decode'

const HASH = 'a'.repeat(64)
const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const bytes = (body: string | Uint8Array, headers: Record<string, string>): Response => new Response(body as BodyInit, { status: 200, headers })
const text = (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer)

describe('an envelope is read as what it says', () => {
  it('a note keeps its title and markdown', async () => {
    const view = await decodeArtifactResponse(json({ kind: 'note', name: 'Plan', title: 'The plan', markdown: '# The plan\n\n**now**' }))
    expect(view).toEqual({ kind: 'note', name: 'Plan', title: 'The plan', markdown: '# The plan\n\n**now**' })
  })

  it('a link keeps its web address', async () => {
    expect(await decodeArtifactResponse(json({ kind: 'link', name: 'Docs', url: 'https://example.com/a' }))).toEqual({ kind: 'link', name: 'Docs', url: 'https://example.com/a' })
  })

  it('a refusal keeps its sentence', async () => {
    const why = 'That file is outside this workspace, so it is not sent to this device.'
    expect(await decodeArtifactResponse(json({ kind: 'unavailable', name: 'x', why }))).toEqual({ kind: 'unavailable', name: 'x', why })
  })

  it('a link that is not a web address is a refusal, never an anchor', async () => {
    const view = await decodeArtifactResponse(json({ kind: 'link', name: 'Bad', url: 'javascript:alert(1)' }))
    expect(view.kind).toBe('unavailable')
  })
})

describe('a file card is read as bytes', () => {
  it('takes the name and hash from the headers when it can read them', async () => {
    const view = await decodeArtifactResponse(
      bytes('<h1>hi</h1>', { 'content-type': 'text/html; charset=utf-8', etag: `"${HASH}"`, 'x-cookrew-artifact': encodeURIComponent('Report — Q4.html') }),
      'card name'
    )
    expect(view.kind).toBe('file')
    if (view.kind !== 'file') return
    expect(view.mime).toBe('text/html')
    expect(view.name).toBe('Report — Q4.html')
    expect(view.hash).toBe(HASH)
    expect(text(view.bytes)).toBe('<h1>hi</h1>')
  })

  it('a .json FILE is bytes, not an envelope, when the route named it', async () => {
    const body = JSON.stringify({ kind: 'note', name: 'looks like one', title: 't', markdown: 'm' })
    const view = await decodeArtifactResponse(bytes(body, { 'content-type': 'application/json', 'x-cookrew-artifact': 'data.json' }))
    expect(view.kind).toBe('file')
    if (view.kind === 'file') expect(text(view.bytes)).toBe(body)
  })

  it('a .json file whose headers were hidden is still bytes when it is not an envelope', async () => {
    const view = await decodeArtifactResponse(bytes('[1,2,3]', { 'content-type': 'application/json' }), 'numbers.json')
    expect(view.kind).toBe('file')
    if (view.kind === 'file') expect(view.name).toBe('numbers.json')
  })

  it('with the headers hidden, falls back to the card name and hashes the bytes itself', async () => {
    const view = await decodeArtifactResponse(bytes(new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' }), 'chart.png')
    expect(view.kind).toBe('file')
    if (view.kind !== 'file') return
    expect(view.name).toBe('chart.png')
    // sha256 of 01 02 03, the same digest the computer computed (main/artifact-view.ts).
    expect(view.hash).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')
  })

  it('a name header that is not percent-encoding is not trusted', async () => {
    const view = await decodeArtifactResponse(bytes('x', { 'content-type': 'text/plain', 'x-cookrew-artifact': '%E0%A4%A' }), 'fallback.txt')
    expect(view.kind === 'file' && view.name).toBe('fallback.txt')
  })
})

describe('how each artifact is shown', () => {
  const file = (mime: string, body = ''): ArtifactPayload => ({ kind: 'file', name: 'f', mime, hash: HASH, bytes: new TextEncoder().encode(body).buffer as ArrayBuffer })

  it('a note becomes a sandboxed page of its markdown, raw HTML as text', () => {
    const show = showOf({ kind: 'note', name: 'n', title: 'T', markdown: '**bold** <img src=x onerror=alert(1)>' })
    expect(show.as).toBe('frame')
    if (show.as !== 'frame') return
    expect(show.srcdoc).toContain('<strong>bold</strong>')
    expect(show.srcdoc).not.toContain('<img src=x')
    expect(show.srcdoc).toContain("default-src 'none'")
  })

  it('an HTML file is its own page; a markdown file is rendered', () => {
    const html = showOf(file('text/html', '<p>page</p><script>1</script>'))
    expect(html.as === 'frame' && html.srcdoc).toBe('<p>page</p><script>1</script>')
    const md = showOf(file('text/markdown', '# Head'))
    expect(md.as === 'frame' && md.srcdoc).toContain('<h1')
  })

  it('images, PDFs, everything else', () => {
    expect(showOf(file('image/png')).as).toBe('image')
    expect(showOf(file('image/svg+xml')).as).toBe('image')
    expect(showOf(file('application/pdf')).as).toBe('pdf')
    expect(showOf(file('application/octet-stream')).as).toBe('save-only')
    expect(showOf(file('video/mp4')).as).toBe('save-only')
  })
})
