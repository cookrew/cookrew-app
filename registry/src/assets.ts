import type { ServerResponse } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { ASSETS, type BundledAsset } from './assets-bundle'

/** Decoded once: a gzipped asset is inflated on first use and kept. */
const decoded = new Map<string, Buffer>()

function bytesOf(name: string, asset: BundledAsset): Buffer {
  const held = decoded.get(name)
  if (held !== undefined) return held
  const bytes =
    asset.encoding === 'gzip'
      ? gunzipSync(Buffer.from(asset.body, 'base64'))
      : Buffer.from(asset.body, asset.encoding === 'base64' ? 'base64' : 'utf8')
  decoded.set(name, bytes)
  return bytes
}

/**
 * STATIC ASSETS, from inside the bundle.
 *
 * The registry is one file, so its scripts and stylesheets are string
 * constants generated from registry/assets/ (scripts/registry-assets.mjs).
 * Served by exact name, never by path walk: there is no directory to walk.
 * Cached long — a change to a script ships as a new bundle, and the pages
 * that load it are cached briefly or not at all.
 */
export function serveAsset(response: ServerResponse, name: string): boolean {
  // Own property only: `toString` and `constructor` are not assets, and a
  // prototype member here is an unauthenticated crash.
  const asset = Object.prototype.hasOwnProperty.call(ASSETS, name) ? ASSETS[name] : undefined
  if (!asset) return false
  const payload = bytesOf(name, asset)
  response.writeHead(200, {
    'content-type': asset.type,
    'content-length': String(payload.byteLength),
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff'
  })
  response.end(payload)
  return true
}
