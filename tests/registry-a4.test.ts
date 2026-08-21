import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { canonicalInstallUrl, installPageHtml, originOf } from '../registry/src/install-page'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'
import { presetIdFromInstallUrl } from '../src/main/registry-install-link'

/**
 * A4 — THE INSTALL PAGE (R21 Option A).
 *
 * https://<registry>/install/<presetId> is one URL with three readers: a canvas
 * browser card intercepts it, a phone deep-links it, and anybody else gets THIS
 * — a plain web page, no app required.
 *
 * Two things it must never become. It is not a review sheet: verification and
 * the contents belong to a client that checked them itself (A5), and a page
 * that showed them would be the registry vouching for its own bytes. And it is
 * not an installer: there is no script on it at all, so "a page can never
 * express install-without-asking" is enforced by the absence of a mechanism
 * rather than by a promise.
 */

const terminal = (name = 'Scout'): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name,
    preset: 'Claude Code',
    command: '',
    cwd: '/w',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  }) as CanvasNode

let base = ''
let store: RegistryStore
let log: TransparencyLog
let author: { publicKey: KeyObject; privateKey: KeyObject }

const seed = (
  name: string,
  version = 1,
  visibility: 'public' | 'identified' = 'public',
  handle = 'drej'
): string => {
  const snapshot: TeamSnapshot = {
    name,
    savedAt: 1,
    dir: '/w',
    nodes: [terminal(name)],
    connections: [],
    turns: {}
  }
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle } })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  const manifest = signManifest(built.manifest, author.privateKey)
  store.putBlob(built.teamBytes)
  store.putManifest({ manifest, teamName: name, visibility, identityId: 'webauthn:drej' })
  return manifest.id
}

const listen = async (): Promise<{ url: string; close: () => void }> => {
  const server = createRegistry({ store, log })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-a4-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  author = generateKeyPairSync('ed25519')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('GET /install/:presetId — the page a phone gets', () => {
  it('names the preset, its author and its version, as HTML', async () => {
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/install/${id}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/)
      const body = await res.text()
      expect(body).toContain('<h1>Deep Research</h1>')
      // The WHOLE byline, not a substring of it. Asserting `toContain('v2')`
      // passed happily over "version v2", which is what rendering the page and
      // reading it caught: deck section 7 spells identity as @handle and R8
      // labels the version, and a substring assertion sees neither.
      expect(body).toContain('published by @drej · v2')
    } finally {
      s.close()
    }
  })

  it('follows R8 exactly: v1–v9 labelled, 10 and up bare, never rounded', async () => {
    // "A wrong version is worse than an absent one" — deck section 7.
    const s = await listen()
    try {
      for (const [version, expected] of [
        [1, 'v1'],
        [9, 'v9'],
        [10, '10'],
        [42, '42'],
        [128, '128']
      ] as [number, string][]) {
        const id = seed(`Crew ${version}`, version)
        const body = await (await fetch(`${s.url}/install/${id}`)).text()
        expect([version, body.includes(`published by @drej · ${expected}`)]).toEqual([version, true])
      }
    } finally {
      s.close()
    }
  })

  it('serves every URL shape the app\'s recogniser accepts', async () => {
    // Atlas's presetIdFromInstallUrl (src/main/registry-install-link.ts on dev)
    // accepts these and lowercases the id. If the page 404s on a link the app
    // recognises, the two halves of R21 disagree about what a link IS — so its
    // own fixtures are the contract here.
    const id = seed('Ship Crew', 4)
    const s = await listen()
    try {
      for (const suffix of [
        id,
        `${id}/`,
        `${id}?ref=twitter`,
        `${id}#top`,
        encodeURIComponent(id),
        id.toUpperCase().replace('SHA256', 'sha256'),
        id.replace('sha256:', 'SHA256:')
      ]) {
        const res = await fetch(`${s.url}/install/${suffix}`)
        expect([suffix, res.status]).toEqual([suffix, 200])
      }
    } finally {
      s.close()
    }
  })

  it('is a different route from /install/x/y — extra segments are not sloppiness', async () => {
    const id = seed('Ship Crew', 4)
    const s = await listen()
    try {
      expect((await fetch(`${s.url}/install/${id}/extra`)).status).toBe(404)
      expect((await fetch(`${s.url}/install`)).status).toBe(404)
    } finally {
      s.close()
    }
  })

  it('answers a page, not a bare 404, for a link that names nothing', async () => {
    // The person following this link did nothing wrong and cannot read a status
    // code. They get a sentence (R14).
    const s = await listen()
    const absent = `sha256:${'a'.repeat(64)}`
    try {
      const res = await fetch(`${s.url}/install/${absent}`)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toMatch(/^text\/html/)
      const body = await res.text()
      expect(body.toLowerCase()).toContain('preset')
      // The id it could not find is not echoed back — nothing is learned by
      // probing, and nothing attacker-shaped reaches the document.
      expect(body).not.toContain(absent)
    } finally {
      s.close()
    }
  })

  it('reflects NOTHING from a malformed path segment — the highest-risk input here', async () => {
    // The id is the only thing in this URL, it comes from whoever wrote the
    // link, and it lands in a document. Every one of these answers the same
    // unknown-preset page, with nothing of the input in it.
    const s = await listen()
    try {
      for (const segment of [
        '%3Cscript%3Ealert(1)%3C%2Fscript%3E',
        '%22%3E%3Cimg%20src%3Dx%3E',
        '..%2F..%2Fetc%2Fpasswd',
        'sha256:zzzz',
        `sha256:${'a'.repeat(63)}`,
        `sha256:${'a'.repeat(65)}`
      ]) {
        const res = await fetch(`${s.url}/install/${segment}`)
        expect([segment, res.status]).toEqual([segment, 404])
        const body = await res.text()
        expect(body).not.toContain('<script>alert(1)</script>')
        expect(body).not.toContain('<img')
        expect(body).not.toContain('passwd')
        expect(body).not.toContain('zzzz')
      }
    } finally {
      s.close()
    }
  })

  it('says a gated preset needs an account, and leaks nothing else about it', async () => {
    // Name, author, version and visibility already ride ungated on search, so
    // the page adds nothing new. The MANIFEST is what the gate protects.
    const id = seed('Pro Toolkit', 1, 'identified')
    const s = await listen()
    try {
      const body = await (await fetch(`${s.url}/install/${id}`)).text()
      expect(body).toContain('Pro Toolkit')
      expect(body.toLowerCase()).toContain('account')
      expect(body).not.toContain('ed25519')
      expect(body).not.toContain('scrub')
    } finally {
      s.close()
    }
  })

  it('never renders a manifest, a signature or a scrub report for ANY preset', async () => {
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const body = await (await fetch(`${s.url}/install/${id}`)).text()
      // The id itself is exempt: it IS the link, and a content address the
      // person already holds is not something the page told them.
      for (const leak of ['ed25519', 'blobs', 'scrub', 'commands', 'team.json']) {
        expect([leak, body.includes(leak)]).toEqual([leak, false])
      }
    } finally {
      s.close()
    }
  })
})

describe('the page cannot install, and cannot claim to have checked anything', () => {
  it('carries no script — the property is enforced by absence, not by promise', async () => {
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const body = await (await fetch(`${s.url}/install/${id}`)).text()
      expect(body.toLowerCase()).not.toContain('<script')
      expect(body.toLowerCase()).not.toContain('javascript:')
      expect(body).not.toMatch(/\son[a-z]+\s*=/i)
      expect(body.toLowerCase()).not.toContain('<form')
    } finally {
      s.close()
    }
  })

  it('refuses to vouch for the bytes — no "verified", "signed" or "safe"', async () => {
    // A5: the client verifies for ITSELF. A registry page asserting that a
    // preset is signed is the registry vouching for its own content, which is
    // the exact trust the signing design refuses to ask for.
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const body = (await (await fetch(`${s.url}/install/${id}`)).text()).toLowerCase()
      for (const claim of ['verified', 'signed ✓', 'safe', 'trusted', 'secure']) {
        expect([claim, body.includes(claim)]).toEqual([claim, false])
      }
    } finally {
      s.close()
    }
  })

  it('sends headers that make the page inert even if one of these slips', async () => {
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/install/${id}`)
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("script-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    } finally {
      s.close()
    }
  })
})

describe('publisher-controlled text is escaped — the name is not ours', () => {
  it('escapes a preset name carrying markup', async () => {
    const hostile = '<script>alert(1)</script>'
    const id = seed(hostile)
    const s = await listen()
    try {
      const body = await (await fetch(`${s.url}/install/${id}`)).text()
      expect(body).not.toContain('<script>alert(1)</script>')
      expect(body).toContain('&lt;script&gt;')
    } finally {
      s.close()
    }
  })

  it('escapes an author handle that tries to close an attribute', async () => {
    const id = seed('Innocent', 1, 'public', '"><img src=x onerror=alert(1)>')
    const s = await listen()
    try {
      const body = await (await fetch(`${s.url}/install/${id}`)).text()
      // `onerror=` survives as TEXT — that is the point of escaping, not a
      // failure of it. What must not survive is the tag that would carry it,
      // or the quote that would break out of the attribute it sits in.
      expect(body).not.toContain('<img src=x')
      expect(body).toContain('&lt;img')
      expect(body).toContain('&quot;&gt;')
    } finally {
      s.close()
    }
  })

  it('does not double an @ a publisher typed themselves', () => {
    const html = installPageHtml({
      kind: 'preset',
      name: 'Crew',
      author: '@drej',
      version: 3,
      gated: false,
      origin: null,
      id: `sha256:${'d'.repeat(64)}`
    })
    expect(html).toContain('published by @drej · v3')
    expect(html).not.toContain('@@')
  })

  it('escapes every one of the five characters that matter', () => {
    const html = installPageHtml({
      kind: 'preset',
      name: `& < > " '`,
      author: `& < > " '`,
      version: 1,
      gated: false,
      origin: 'https://registry.cookrew.dev',
      id: `sha256:${'b'.repeat(64)}`
    })
    expect(html).toContain('&amp; &lt; &gt; &quot; &#39;')
  })
})

describe('the canonical link the page shows', () => {
  it('is the same shape the app recognises, built from the host that served it', async () => {
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const body = await (await fetch(`${s.url}/install/${id}`)).text()
      // Loopback is served over http; the shape is what matters.
      expect(body).toContain(`/install/${id}`)
    } finally {
      s.close()
    }
  })

  it('REFUSES to reflect a hostile Host header, rather than escaping it and hoping', () => {
    // Host is chosen by whoever sends the request. Rendering it is how a page
    // gets poisoned into advertising somebody else's URL, so anything that is
    // not host[:port] produces no link at all.
    for (const hostile of [
      'evil.test/"><script>',
      'a b',
      'host\r\nX-Injected: 1',
      '',
      'x'.repeat(300),
      'host:99999999'
    ]) {
      expect([hostile, originOf(hostile)]).toEqual([hostile, null])
    }
  })

  it('accepts an ordinary host, and http only on loopback', () => {
    expect(originOf('registry.cookrew.dev')).toBe('https://registry.cookrew.dev')
    expect(originOf('registry.cookrew.dev:8443')).toBe('https://registry.cookrew.dev:8443')
    expect(originOf('127.0.0.1:8791')).toBe('http://127.0.0.1:8791')
    expect(originOf('localhost:8791')).toBe('http://localhost:8791')
  })

  it('renders the page WITHOUT a link when the host cannot be trusted', () => {
    const html = installPageHtml({
      kind: 'preset',
      name: 'Deep Research',
      author: 'drej',
      version: 2,
      gated: false,
      origin: null,
      id: `sha256:${'c'.repeat(64)}`
    })
    expect(html).toContain('Deep Research')
    expect(html).not.toContain('/install/')
  })
})

/* ------------------------------------------- the two halves of R21 agree --- */

describe('round trip: the page\'s own link, back through the app\'s recogniser', () => {
  /**
   * FLAGGED AT A4, WRITABLE ONLY NOW. This assertion needs BOTH halves of R21 in
   * one tree: the registry that emits the canonical link, and Atlas's
   * presetIdFromInstallUrl that recognises it. The branch was cut before his
   * hook merged, so at A4 I could only test the page against his fixtures by
   * hand and record this as a merge-time item. The rebase onto dev is the
   * moment it becomes real, so here it is.
   *
   * What it proves is the thing neither half can prove alone: the URL the page
   * PUBLISHES is the URL the app RECOGNISES, and the id survives the trip
   * unchanged.
   */
  const HOSTS = ['registry.cookrew.dev']

  it('emits a link the app parses back to the same preset id', () => {
    const id = `sha256:${'9f'.repeat(32)}`
    const url = canonicalInstallUrl('https://registry.cookrew.dev', id)
    expect(presetIdFromInstallUrl(url, HOSTS)).toBe(id)
  })

  it('holds for every id the store can address, not one lucky digest', () => {
    for (const hex of ['0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      const id = `sha256:${hex}`
      const url = canonicalInstallUrl('https://registry.cookrew.dev', id)
      expect([id, presetIdFromInstallUrl(url, HOSTS)]).toEqual([id, id])
    }
  })

  it('survives the loopback origin the dev registry actually serves on', () => {
    // originOf() gives http for loopback; Atlas's recogniser allows http there
    // and nowhere else. Both halves have to agree about that exception or the
    // dev registry is unusable from a canvas card.
    const id = `sha256:${'ab'.repeat(32)}`
    const origin = originOf('localhost:8790')
    expect(origin).toBe('http://localhost:8790')
    const url = canonicalInstallUrl(origin as string, id)
    expect(presetIdFromInstallUrl(url, ['localhost:8790'])).toBe(id)
  })

  it('a link this page would never emit is still refused by the app', () => {
    // The guard rail on the round trip: agreement must not have been bought by
    // making the recogniser permissive.
    const id = `sha256:${'ab'.repeat(32)}`
    expect(presetIdFromInstallUrl(`https://evil.test/install/${id}`, HOSTS)).toBeNull()
    expect(presetIdFromInstallUrl(`http://registry.cookrew.dev/install/${id}`, HOSTS)).toBeNull()
  })
})
