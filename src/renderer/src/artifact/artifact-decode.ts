import { escapeHtml, renderNoteMarkdown } from '../note-markdown'

/**
 * WHAT THE COMPUTER SENT FOR AN ARTIFACT, AS THIS DEVICE READS IT
 * (main/artifact-view.ts · GET /api/artifact/<card id>).
 *
 * A note, a link or a refusal arrive as a JSON envelope; a file card as its
 * own bytes. Two things make the reading less simple than the route:
 *
 *   A FILE CAN BE JSON TOO. A `.json` artifact is `application/json`, the same
 *   type as an envelope. The route names a file with `x-cookrew-artifact` and
 *   a strong ETag of its sha256; when either is readable it settles the
 *   question. When neither is, only a body that IS a whole envelope is one.
 *
 *   THE HEADERS MAY BE HIDDEN. Across origins (a direct plane from the relay's
 *   page, companion-cors.ts) a browser shows the safelisted headers only, and
 *   the relay passes the ETag but not the name. So the name falls back to the
 *   card's own, and the hash is taken here, the same sha256 the computer took.
 */

export interface ArtifactFile {
  readonly kind: 'file'
  readonly name: string
  /** The base MIME type, with no parameters. */
  readonly mime: string
  /** SHA-256 hex of the bytes, or null when unavailable. */
  readonly hash: string | null
  readonly bytes: ArrayBuffer
}

export type ArtifactPayload =
  | { readonly kind: 'note'; readonly name: string; readonly title: string; readonly markdown: string }
  | { readonly kind: 'link'; readonly name: string; readonly url: string }
  | { readonly kind: 'unavailable'; readonly name: string; readonly why: string }
  | ArtifactFile

/** How the sheet draws one. A frame is a sandboxed blob document. */
export type ArtifactShow =
  | { readonly as: 'frame'; readonly srcdoc: string }
  | { readonly as: 'image' }
  | { readonly as: 'pdf' }
  | { readonly as: 'save-only' }
  | { readonly as: 'link'; readonly url: string }
  | { readonly as: 'unavailable'; readonly why: string }

const NAME_HEADER = 'x-cookrew-artifact'
const STRONG_HASH = /^"([0-9a-f]{64})"$/
const DEFAULT_NAME = 'artifact'

const baseType = (contentType: string | null): string => (contentType ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()

const isText = (value: unknown): value is string => typeof value === 'string'

const isWebUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/** sha256 hex, or null where WebCrypto is not offered (a page outside a secure context). */
export async function sha256Hex(data: ArrayBuffer | string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const input = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    const digest = new Uint8Array(await subtle.digest('SHA-256', input))
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** The envelope the body is, or null when it is not exactly one. */
function envelopeOf(body: unknown): ArtifactPayload | null {
  if (typeof body !== 'object' || body === null) return null
  const v = body as Record<string, unknown>
  if (!isText(v.name)) return null
  if (v.kind === 'note' && isText(v.title) && isText(v.markdown)) return { kind: 'note', name: v.name, title: v.title, markdown: v.markdown }
  if (v.kind === 'unavailable' && isText(v.why)) return { kind: 'unavailable', name: v.name, why: v.why }
  if (v.kind === 'link' && isText(v.url)) {
    // Only a web page is handed to the device to open; anything else would be an anchor that runs.
    return isWebUrl(v.url) ? { kind: 'link', name: v.name, url: v.url } : { kind: 'unavailable', name: v.name, why: 'This card is not showing a web page this device can open.' }
  }
  return null
}

function nameFrom(header: string | null, fallback: string | undefined): string {
  if (header) {
    try {
      const name = decodeURIComponent(header).trim()
      if (name !== '') return name
    } catch {
      // Not percent-encoding: not the route's own header, so not trusted for a file name.
    }
  }
  return fallback?.trim() || DEFAULT_NAME
}

async function filePayload(bytes: ArrayBuffer, mime: string, named: string | null, hash: string | null, fallbackName?: string): Promise<ArtifactFile> {
  return { kind: 'file', name: nameFrom(named, fallbackName), mime, hash: hash ?? (await sha256Hex(bytes)), bytes }
}

function fileHeaders(response: Response, nameHeader: string): { mime: string; named: string | null; hash: string | null } {
  return {
    mime: baseType(response.headers.get('content-type')),
    named: response.headers.get(nameHeader),
    hash: STRONG_HASH.exec(response.headers.get('etag') ?? '')?.[1] ?? null
  }
}

/** A successful raw-file response always carries bytes, including JSON files. */
export async function decodeFileResponse(response: Response, nameHeader: string, fallbackName: string): Promise<ArtifactFile> {
  const { mime, named, hash } = fileHeaders(response, nameHeader)
  return filePayload(await response.arrayBuffer(), mime, named, hash, fallbackName)
}

/** Read a 2xx answer of the artifact route. A refusal status is the caller's to handle first. */
export async function decodeArtifactResponse(response: Response, fallbackName?: string): Promise<ArtifactPayload> {
  const { mime, named, hash } = fileHeaders(response, NAME_HEADER)
  const bytes = await response.arrayBuffer()
  const routeSaysFile = named !== null || hash !== null
  if (mime === 'application/json' && !routeSaysFile) {
    try {
      const envelope = envelopeOf(JSON.parse(new TextDecoder().decode(bytes)))
      if (envelope) return envelope
    } catch {
      // Not JSON that parses: a file that only claims the type.
    }
  }
  return filePayload(bytes, mime, named, hash, fallbackName)
}

const FRAME_STYLE = [
  'body{margin:0;padding:18px 20px 40px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1b1813;background:#faf8f4;word-wrap:break-word}',
  'img{max-width:100%}pre{overflow-x:auto;padding:10px;background:#efe9dc;border-radius:6px}code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}',
  'table{border-collapse:collapse;display:block;overflow-x:auto}td,th{border:1px solid #d8d0bf;padding:4px 8px}',
  'a{color:#8a5a00}',
  '@media (prefers-color-scheme:dark){body{color:#ece5d3;background:#16140f}pre{background:#25221b}td,th{border-color:#37322a}a{color:#e8b64a}}'
].join('')

/**
 * A page around rendered markdown. Its own policy runs nothing and fetches
 * nothing but pictures: the markdown is already escaped (note-markdown.ts),
 * and this is the belt to that brace.
 */
export function markdownDocument(title: string, markdown: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title><style>${FRAME_STYLE}</style></head>`,
    `<body>${renderNoteMarkdown(markdown)}</body></html>`
  ].join('')
}

/** How a payload is drawn on this device. Pure: the sheet and its tests share it. */
export function showOf(payload: ArtifactPayload): ArtifactShow {
  switch (payload.kind) {
    case 'note':
      return { as: 'frame', srcdoc: markdownDocument(payload.title, payload.markdown) }
    case 'link':
      return { as: 'link', url: payload.url }
    case 'unavailable':
      return { as: 'unavailable', why: payload.why }
    case 'file': {
      if (payload.mime === 'text/html') return { as: 'frame', srcdoc: new TextDecoder().decode(payload.bytes) }
      if (payload.mime === 'text/markdown') return { as: 'frame', srcdoc: markdownDocument(payload.name, new TextDecoder().decode(payload.bytes)) }
      if (payload.mime.startsWith('image/')) return { as: 'image' }
      if (payload.mime === 'application/pdf') return { as: 'pdf' }
      return { as: 'save-only' }
    }
  }
}
