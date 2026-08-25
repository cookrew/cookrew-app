// The registry install link (R21).
//
// A canvas browser card showing the marketplace navigates to
// https://<registry-host>/install/<presetId>, and that navigation hands main a
// preset id. This is a WEB PAGE reaching across into the app, so the recogniser
// is written adversarially: anything that is not exactly the agreed shape,
// served from exactly an allow-listed host over https, is not a link.
//
// What crosses is the preset id and nothing else — no URL, no query, no
// fragment, no referrer. Main owns download, verify and the review sheet, so a
// recognised link is a REQUEST TO REVIEW, never an install.

import { describe, expect, it } from 'vitest'
import { presetIdFromInstallUrl } from '../src/main/registry-install-link'

const HOSTS = ['registry.cookrew.dev']
const ID = 'sha256:9f2c4a1b8e7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f'

describe('the agreed shape', () => {
  it('recognises a canonical install link', () => {
    expect(presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${ID}`, HOSTS)).toBe(ID)
  })

  it('accepts a trailing slash', () => {
    expect(presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${ID}/`, HOSTS)).toBe(ID)
  })

  it('ignores query and fragment — only the id crosses', () => {
    // A marketplace page will carry analytics params. None of that is the
    // app's business, and carrying them would make the boundary wider than
    // "one preset id".
    expect(
      presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${ID}?ref=twitter#top`, HOSTS)
    ).toBe(ID)
  })

  it('is case-insensitive about the host, as hosts are', () => {
    expect(presetIdFromInstallUrl(`https://REGISTRY.Cookrew.dev/install/${ID}`, HOSTS)).toBe(ID)
  })
})

describe('host must match EXACTLY — no suffix games', () => {
  it('refuses a lookalike that merely ends with the registry host', () => {
    // The classic: evil-registry.cookrew.dev.attacker.com, and its mirror,
    // notregistry.cookrew.dev. A suffix check passes both.
    expect(
      presetIdFromInstallUrl(`https://registry.cookrew.dev.attacker.com/install/${ID}`, HOSTS)
    ).toBeNull()
    expect(
      presetIdFromInstallUrl(`https://notregistry.cookrew.dev/install/${ID}`, HOSTS)
    ).toBeNull()
  })

  it('refuses a subdomain of the registry host', () => {
    expect(presetIdFromInstallUrl(`https://evil.registry.cookrew.dev/install/${ID}`, HOSTS)).toBeNull()
  })

  it('refuses an unrelated host', () => {
    expect(presetIdFromInstallUrl(`https://example.com/install/${ID}`, HOSTS)).toBeNull()
  })

  it('refuses userinfo smuggling the host', () => {
    // https://registry.cookrew.dev@attacker.com/... — the ACTUAL host is
    // attacker.com, and a naive string search for the registry host finds it.
    expect(
      presetIdFromInstallUrl(`https://registry.cookrew.dev@attacker.com/install/${ID}`, HOSTS)
    ).toBeNull()
  })

  it('refuses everything when no host is configured', () => {
    // Fail closed: an unconfigured registry recognises nothing, rather than
    // recognising anything.
    expect(presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${ID}`, [])).toBeNull()
  })
})

describe('https only', () => {
  it('refuses http', () => {
    // A plaintext install link is an injection point on any shared network.
    expect(presetIdFromInstallUrl(`http://registry.cookrew.dev/install/${ID}`, HOSTS)).toBeNull()
  })

  it('refuses non-web schemes outright', () => {
    for (const url of [
      `file:///install/${ID}`,
      `javascript:void(0)/install/${ID}`,
      `data:text/html,/install/${ID}`,
      `cookrew://install/${ID}`
    ]) {
      expect(presetIdFromInstallUrl(url, HOSTS)).toBeNull()
    }
  })

  it('allows http on localhost for the dev registry', () => {
    // P2-A's dev-mode story runs a local registry; requiring https there would
    // mean either a self-signed cert or no dev flow at all. Loopback is not a
    // shared network, so the reason for the https rule does not apply.
    expect(presetIdFromInstallUrl(`http://localhost:8787/install/${ID}`, ['localhost:8787'])).toBe(
      ID
    )
    expect(
      presetIdFromInstallUrl(`http://127.0.0.1:8787/install/${ID}`, ['127.0.0.1:8787'])
    ).toBe(ID)
  })

  it('does NOT allow http on a non-loopback host that happens to be configured', () => {
    expect(presetIdFromInstallUrl(`http://registry.internal/install/${ID}`, ['registry.internal']))
      .toBeNull()
  })
})

describe('the path must be exactly /install/<id>', () => {
  it('refuses a different path', () => {
    expect(presetIdFromInstallUrl(`https://registry.cookrew.dev/presets/${ID}`, HOSTS)).toBeNull()
    expect(presetIdFromInstallUrl('https://registry.cookrew.dev/install', HOSTS)).toBeNull()
    expect(presetIdFromInstallUrl('https://registry.cookrew.dev/install/', HOSTS)).toBeNull()
  })

  it('refuses extra path segments after the id', () => {
    expect(
      presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${ID}/extra`, HOSTS)
    ).toBeNull()
  })

  it('refuses a traversal in the id position', () => {
    expect(
      presetIdFromInstallUrl('https://registry.cookrew.dev/install/..%2F..%2Fetc', HOSTS)
    ).toBeNull()
  })
})

describe('the id must be a content address', () => {
  it('refuses an id that is not sha256:<64 hex>', () => {
    for (const bad of [
      'sha256:tooshort',
      'sha256:' + 'z'.repeat(64),
      'md5:' + 'a'.repeat(32),
      'a'.repeat(64),
      'sha256:' + 'a'.repeat(65)
    ]) {
      expect(
        presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${bad}`, HOSTS)
      ).toBeNull()
    }
  })

  it('accepts upper-case hex, normalising to lower', () => {
    // Content addresses compare by value; two spellings of one digest must not
    // become two presets.
    const upper = `sha256:${'9F2C4A1B8E7D6C5F4A3B2C1D0E9F8A7B6C5D4E3F2A1B0C9D8E7F6A5B4C3D2E1F'}`
    expect(presetIdFromInstallUrl(`https://registry.cookrew.dev/install/${upper}`, HOSTS)).toBe(
      upper.toLowerCase()
    )
  })
})

describe('never throws on hostile input', () => {
  it('returns null for unparseable URLs rather than throwing', () => {
    // This runs on a navigation event from a page the user does not control.
    // A throw here would surface as a browser card that dies on a bad link.
    for (const url of ['', 'not a url', '://', 'https://', '%%%']) {
      expect(() => presetIdFromInstallUrl(url, HOSTS)).not.toThrow()
      expect(presetIdFromInstallUrl(url, HOSTS)).toBeNull()
    }
  })
})
