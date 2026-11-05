import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { ReleaseCache } from '../registry/src/releases'
import { CommitsCache } from '../registry/src/github-commits'
import { KEEP_DAYS as PULSE_DAYS, Pulse } from '../registry/src/pulse'
import { KEEP_DAYS as FUNNEL_DAYS } from '../registry/src/funnel-counts'
import { SEEN_KEEP_MS } from '../registry/src/v2-line-seen'
import { REVOKED_MAX, SESSIONS_MAX } from '../registry/src/v2-accounts'
import { SEATS_MAX } from '../registry/src/v2-seats'
import { REACH_TTL_MS, SEAT_TTL_MS } from '../registry/src/v2-requests'
import { PENDING_TTL_MS } from '../registry/src/v2-pending'
import { SESSION_TTL_MS } from '../registry/src/v2-tokens'
import { PER_ACCOUNT as EVENTS_KEPT } from '../registry/src/v2-events'
import { FAQ, FACTS, FEATURES } from '../registry/src/site-content'
import { sitemapXml } from '../registry/src/site-seo'
import { SITE_STYLE } from '../registry/src/site-shell'
import { installPageHtml } from '../registry/src/install-page'
import { legalBody, privacyPage, termsPage } from '../registry/src/site-legal'
import {
  CONTACT_EMAIL,
  GOVERNING_LAW,
  LEGAL_ENTITY,
  PRIVACY,
  TERMS,
  type LegalSection
} from '../registry/src/site-legal-content'
import { FUNNEL_EVENTS, FUNNEL_PAYLOAD_KEYS, TELEMETRY_DEFAULT_ON } from '../src/shared/funnel-events'

/**
 * THE LEGAL PAGES. Three things can go wrong with them and all three are
 * quiet: the address stops answering (Google's consent screen points here),
 * the footer stops linking them, or the code moves on while the words stay
 * behind. So the numbers below are read from the code the page describes.
 */

const CONFIG = { rpId: 'localhost', origin: 'http://localhost:8790', tokenTtlMs: 600_000, challengeTtlMs: 90_000 }
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'site-legal-'))
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir, CONFIG),
    doors: new DoorStore(dir, { allowPrivate: true }),
    relay: true,
    origin: 'https://cookrew.dev',
    stars: new StarStore(dir),
    releases: new ReleaseCache({ fetch: async () => new Response('{}', { status: 500 }), ttlMs: 60_000 }),
    pulse: new Pulse(dir),
    commits: new CommitsCache({ fetch: async () => new Response('[]', { status: 200 }), ttlMs: 60_000 })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
})

afterAll(async () => {
  await close()
  rmSync(dir, { recursive: true, force: true })
})

const footerOf = (html: string): string => /<footer>[\s\S]*<\/footer>/.exec(html)?.[0] ?? ''
const linksBoth = (html: string): boolean => {
  const footer = footerOf(html)
  return footer.includes('href="/privacy"') && footer.includes('href="/terms"')
}

/** Every word of a section, as a reader meets it. */
const wordsOf = (section: LegalSection): string =>
  [
    section.heading,
    ...section.blocks.flatMap((block) =>
      'p' in block ? [block.p] : 'ul' in block ? block.ul : [...block.table.head, ...block.table.rows.flat()]
    )
  ].join(' ')
const allWords = (sections: readonly LegalSection[]): string => sections.map(wordsOf).join(' ')
const live = (sections: readonly LegalSection[]): readonly LegalSection[] => sections.filter((s) => !s.planned)
const planned = (sections: readonly LegalSection[]): readonly LegalSection[] => sections.filter((s) => s.planned)

describe('the addresses', () => {
  it.each(['/privacy', '/terms'])('%s answers as a page, not as an owner called that', async (address) => {
    const response = await fetch(`${origin}${address}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain(`<link rel="canonical" href="https://cookrew.dev${address}">`)
    expect(html).not.toContain('Nobody by that name')
  })

  it.each(['/privacy', '/terms'])('%s is a document: it runs nothing', async (address) => {
    const response = await fetch(`${origin}${address}`)
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(await response.text()).not.toMatch(/<script(?![^>]*application\/ld\+json)/)
  })

  it('HEAD answers too: a consent-screen check may never fetch the body', async () => {
    const response = await fetch(`${origin}/privacy`, { method: 'HEAD' })
    expect(response.status).toBe(200)
  })

  it('both are in the sitemap', () => {
    const xml = sitemapXml([])
    expect(xml).toContain('<loc>https://cookrew.dev/privacy</loc>')
    expect(xml).toContain('<loc>https://cookrew.dev/terms</loc>')
  })
})

describe('the footer of every page', () => {
  it.each([
    '/',
    '/market',
    '/privacy',
    '/terms',
    '/join',
    `/features/${FEATURES[0].slug}`,
    '/nobody-here',
    '/nobody-here/no-team',
    '/features/no-such-feature'
  ])('%s links both', async (address) => {
    expect(linksBoth(await (await fetch(`${origin}${address}`)).text())).toBe(true)
  })

  it('the install page keeps its own markup and links both as well', () => {
    expect(linksBoth(installPageHtml({ kind: 'unknown' }))).toBe(true)
    expect(linksBoth(installPageHtml({ kind: 'preset', name: 'Ship Crew', version: 4, author: 'mira', id: 'x' }))).toBe(true)
  })
})

describe('placeholders', () => {
  it('stay visible and are marked, in both documents', () => {
    const privacy = privacyPage().body
    const terms = termsPage().body
    for (const value of [LEGAL_ENTITY, CONTACT_EMAIL]) {
      expect(privacy).toContain(`<mark class="ph">${value}</mark>`)
      expect(terms).toContain(`<mark class="ph">${value}</mark>`)
    }
    expect(terms).toContain(`<mark class="ph">${GOVERNING_LAW}</mark>`)
  })

  it('no bracketed word is left unmarked', () => {
    for (const html of [privacyPage().body, termsPage().body]) {
      const main = html.slice(html.indexOf('class="legal"'), html.indexOf('<footer>'))
      expect(main.replace(/<mark class="ph">\[[A-Z ]+\]<\/mark>/g, '')).not.toMatch(/\[[A-Z ]+\]/)
    }
  })
})

describe('rendering', () => {
  it('escapes what it is given', () => {
    const html = legalBody({
      title: 'T',
      lede: 'a <b> lede',
      updated: '2026-11-05',
      sections: [
        {
          id: 's',
          heading: 'x & y',
          blocks: [{ p: '<script>' }, { ul: ['<i>'] }, { table: { head: ['<h>'], rows: [['<c>']] } }]
        }
      ]
    })
    expect(html).not.toMatch(/<(script|b|i|h|c)>/)
    expect(html).toContain('x &amp; y')
  })

  it('every cell carries its column name, so a phone can stack the table and lose no column', () => {
    const html = legalBody({
      title: 'T',
      lede: 'L',
      updated: '2026-11-05',
      sections: [{ id: 's', heading: 'H', blocks: [{ table: { head: ['Record', 'What', 'Who "sees"'], rows: [['a', 'b', 'c']] } }] }]
    })
    expect(html).toContain('<div class="legal-table"><table class="cmp">')
    expect(html).toContain('<td data-label="What">b</td>')
    expect(html).toContain('<td data-label="Who &quot;sees&quot;">c</td>')
  })

  it('the stacked table and the anchor offset are in the one stylesheet', () => {
    expect(SITE_STYLE).toMatch(/@media \(max-width:700px\)\{[^}]*\.legal-table thead\{display:none\}/)
    expect(SITE_STYLE).toContain('content:attr(data-label)')
    // The id is on the section, so the offset must be too, or a contents link lands under the sticky header.
    expect(SITE_STYLE).toMatch(/\.legal section\{[^}]*scroll-margin-top:/)
  })

  it('section ids are unique, because the contents list links to them', () => {
    for (const sections of [PRIVACY.sections, TERMS.sections]) {
      const ids = sections.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('planned sections are unmistakable', () => {
  it('both documents carry OAuth sign-in and paid credits as planned, and only as planned', () => {
    for (const doc of [PRIVACY, TERMS]) {
      const words = allWords(planned(doc.sections))
      expect(words).toMatch(/GitHub/)
      expect(words).toMatch(/Google/)
      expect(words).toMatch(/credits/i)
      expect(allWords(live(doc.sections))).not.toMatch(/OAuth|Sign in with|API credits/i)
    }
  })

  it('a planned section says so on the page, in its heading and in its first line', () => {
    const html = privacyPage().body
    const count = planned(PRIVACY.sections).length
    expect(count).toBeGreaterThanOrEqual(2)
    expect(html.match(/<section class="legal-planned"/g)?.length).toBe(count)
    expect(html.match(/<span class="chip legal-chip">Planned, not live<\/span>/g)?.length).toBe(count)
    for (const section of planned(PRIVACY.sections)) {
      expect(section.heading).toMatch(/^Planned:/)
      expect(wordsOf(section)).toMatch(/not live/i)
    }
  })

  it('the Google promise is all four promises, and asks for no repository', () => {
    const words = allWords(planned(PRIVACY.sections))
    expect(words).toMatch(/only for sign-in/i)
    expect(words).toMatch(/not sold/i)
    expect(words).toMatch(/not used for advertising/i)
    expect(words).toMatch(/not used .*train/i)
    expect(words).toMatch(/verified email/i)
    expect(words).toMatch(/no access to your repositories/i)
  })
})

describe('the words match the code', () => {
  const privacy = allWords(PRIVACY.sections)

  it('names every funnel event and field, from the allowlist itself', () => {
    const funnel = wordsOf(PRIVACY.sections.find((s) => s.id === 'funnel') as LegalSection)
    for (const event of FUNNEL_EVENTS) expect(funnel).toContain(event)
    for (const key of FUNNEL_PAYLOAD_KEYS) expect(funnel).toContain(key)
  })

  it('says what the telemetry default actually is', () => {
    expect(privacy).toContain(TELEMETRY_DEFAULT_ON ? 'On by default' : 'Off by default')
  })

  it('carries each retention figure the code enforces', () => {
    const retention = wordsOf(PRIVACY.sections.find((s) => s.id === 'retention') as LegalSection)
    expect(retention).toContain(`${PULSE_DAYS} days`)
    expect(retention).toContain(`${FUNNEL_DAYS} days`)
    expect(retention).toContain(`${SEEN_KEEP_MS / DAY_MS} days`)
    expect(retention).toContain(`${SESSION_TTL_MS / DAY_MS} days`)
    expect(retention).toContain(`${SEAT_TTL_MS / DAY_MS} days`)
    expect(retention).toContain(`${PENDING_TTL_MS / MINUTE_MS} minutes`)
    expect(retention).toContain(`${REACH_TTL_MS / MINUTE_MS} minutes`)
    expect(retention).toContain(`last ${SESSIONS_MAX} sessions`)
    expect(retention).toContain(`last ${REVOKED_MAX}`)
    expect(retention).toContain(`last ${EVENTS_KEPT}`)
    expect(retention).toContain(SEATS_MAX.toLocaleString('en-US'))
  })

  it('tells the two relays apart: one sealed, one not', () => {
    const relay = wordsOf(PRIVACY.sections.find((s) => s.id === 'relay') as LegalSection)
    expect(relay).toContain(FACTS.relayCipher)
    expect(relay).toMatch(/not end-to-end encrypted/i)
  })

  it('never claims a delete button the registry does not have', () => {
    const route = wordsOf(PRIVACY.sections.find((s) => s.id === 'choices') as LegalSection)
    expect(route).toMatch(/no delete-account button/i)
    expect(route).toContain(CONTACT_EMAIL)
  })

  it('the FAQ no longer says a canvas never touches cookrew.dev', () => {
    const answer = FAQ.find((f) => f.q === 'Is my code sent to cookrew.dev?')?.a ?? ''
    expect(answer).not.toMatch(/never touches cookrew\.dev unless you serve a team\.$/)
    expect(answer).toMatch(/relay/)
    expect(answer).toContain('/privacy')
  })
})
