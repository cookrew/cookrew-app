import type { ServerResponse } from 'node:http'
import { ASSETS } from './assets-bundle'

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
  const asset = ASSETS[name]
  if (!asset) return false
  const payload = Buffer.from(asset.body, 'utf8')
  response.writeHead(200, {
    'content-type': asset.type,
    'content-length': String(payload.byteLength),
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff'
  })
  response.end(payload)
  return true
}

export function hasAsset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, name)
}
