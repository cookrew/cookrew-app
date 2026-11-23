import { sha256Hex, type ArtifactPayload } from './artifact-decode'

/**
 * A COPY KEPT ON THIS DEVICE (Cache Storage), so "Saved on this device" is a
 * fact and not a hope. A file is kept by its sha256 — the same bytes from any
 * card are one copy — and a note by its card and the hash of its text.
 *
 * Cache Storage wants an http(s) URL as the key; the key is a made-up path on
 * this page's own origin that no request ever goes to. Where there is no
 * Cache Storage (an insecure context, the desktop's file:// page) nothing is
 * kept and nothing claims to be.
 */

const CACHE_NAME = 'cookrew-artifacts-v1'
const KEY_PREFIX = '/__cookrew-artifact/'

/** The key a payload is kept under, or null when it is nothing to keep or cannot be hashed. */
export async function cacheKeyOf(id: string, payload: ArtifactPayload): Promise<string | null> {
  if (payload.kind === 'file') return payload.hash === null ? null : `file/${payload.hash}`
  if (payload.kind !== 'note') return null
  const hash = await sha256Hex(payload.markdown)
  return hash === null ? null : `note/${encodeURIComponent(id)}/${hash}`
}

function keyUrl(key: string): string | null {
  const origin = globalThis.location?.origin
  if (!origin || !/^https?:/.test(origin)) return null
  return `${origin}${KEY_PREFIX}${key}`
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    // Storage refused (private mode, quota): no copy, and the sheet says nothing about one.
    return null
  }
}

/** Is a copy already kept here. */
export async function isSaved(key: string): Promise<boolean> {
  const url = keyUrl(key)
  const cache = url === null ? null : await openCache()
  if (cache === null || url === null) return false
  try {
    return (await cache.match(url)) !== undefined
  } catch {
    return false
  }
}

/** Keep a copy here. True only when it was kept. */
export async function saveCopy(key: string, blob: Blob, name: string): Promise<boolean> {
  const url = keyUrl(key)
  const cache = url === null ? null : await openCache()
  if (cache === null || url === null) return false
  try {
    await cache.put(url, new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream', 'x-cookrew-artifact': encodeURIComponent(name) } }))
    return true
  } catch {
    return false
  }
}
