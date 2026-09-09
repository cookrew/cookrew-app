import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerSecretPaths, browserStatePaths, defaultSessionStatePaths } from '../src/main/owner-secrets'

const HOME = '/Users/owner'
const BASE = '/Users/owner/.cookrew'

describe('browserStatePaths — where a card keeps its logged-in identity', () => {
  it('names all three stores, because Chrome and Electron split a profile', () => {
    // Measured: retiring a card cleaned userData and left the Caches twin and
    // the canvas partition behind. A deny list that knows only one of the three
    // leaves the other two readable.
    const paths = browserStatePaths(HOME, 'Cookrew')
    expect(paths.some((p) => p.endsWith(path.join('Cookrew', 'interactive-browser')))).toBe(true)
    expect(paths.some((p) => p.includes(path.join('Caches', 'Cookrew')))).toBe(true)
    expect(paths.some((p) => p.endsWith(path.join('Cookrew', 'Partitions')))).toBe(true)
  })

  it('is absolute and rooted under the owner home', () => {
    for (const p of browserStatePaths(HOME, 'Cookrew')) {
      expect(path.isAbsolute(p)).toBe(true)
      expect(p.startsWith(HOME)).toBe(true)
    }
  })
})

describe('ownerSecretPaths — a served agent may not read the owner browsing identity', () => {
  const paths = ownerSecretPaths(BASE, HOME)

  it('denies the headless browser profiles', () => {
    // `file-read*` is allowed across the disk, so a served agent could read
    // Default/Cookies for every card the owner ever logged into. That is the
    // owner's live sessions for every site, lent to nobody.
    expect(paths.some((p) => p.includes('interactive-browser'))).toBe(true)
  })

  it('denies the canvas webview partitions too', () => {
    expect(paths.some((p) => p.endsWith('Partitions'))).toBe(true)
  })

  it('still denies everything it denied before', () => {
    // A regression here silently re-opens a credential store, so the previous
    // list is asserted whole rather than sampled.
    for (const tail of [
      '.claude/.credentials.json',
      '.claude.json',
      '.ssh',
      '.aws',
      '.gnupg',
      '.netrc',
      '.npmrc',
      '.pypirc',
      '.docker/config.json',
      '.kube',
      '.config/gh',
      '.config/gcloud'
    ]) {
      expect(paths).toContain(path.join(HOME, ...tail.split('/')))
    }
    for (const own of ['sous.json', 'qwen.env', 'stripe.env', 'payment.json']) {
      expect(paths).toContain(path.join(BASE, own))
    }
  })

  it('does not deny the whole app-support tree', () => {
    // Denying the parent would take the app's own settings with it; the point
    // is the browsing identity, not everything Cookrew stores.
    expect(paths).not.toContain(path.join(HOME, 'Library', 'Application Support', 'Cookrew'))
  })
})

describe('defaultSessionStatePaths — the app own origin state (P2 residual ruling)', () => {
  it('denies each storage entry by name, never the tree', () => {
    // The Electron DEFAULT session writes its storage directly under the
    // app-support dir — Cookies, Local Storage, IndexedDB sitting beside
    // settings a harness legitimately reads. So the denies are file-level:
    // every entry the default session is known to write, and not the parent.
    const paths = defaultSessionStatePaths(HOME, 'cookrew')
    const app = path.join(HOME, 'Library', 'Application Support', 'cookrew')
    for (const entry of [
      'Cookies',
      'Cookies-journal',
      'Local Storage',
      'IndexedDB',
      'Session Storage',
      'SharedStorage',
      'SharedStorage-wal',
      'Trust Tokens',
      'Trust Tokens-journal',
      'Network Persistent State',
      'WebStorage',
      'blob_storage'
    ]) {
      expect(paths).toContain(path.join(app, entry))
    }
    expect(paths).not.toContain(app)
  })

  it('rides into ownerSecretPaths', () => {
    const paths = ownerSecretPaths(BASE, HOME)
    const app = path.join(HOME, 'Library', 'Application Support', 'cookrew')
    expect(paths).toContain(path.join(app, 'Cookies'))
    expect(paths).toContain(path.join(app, 'Local Storage'))
    expect(paths).not.toContain(app)
  })
})
