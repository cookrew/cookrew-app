import { describe, expect, it } from 'vitest'
import { RESERVED_HANDLES, doorPage, handlePage, homePage } from '../registry/src/site'
import type { DoorRecord } from '../registry/src/doors'

/**
 * THE PUBLIC FACE OF cookrew.dev.
 *
 * These pages are read by people deciding whether to open somebody else's
 * team, so what they must never do matters more than what they say: they must
 * not be able to run anything, must not leak where the author's machine is,
 * and must not imply the reader is entitled to something the gate has not
 * granted yet.
 */

const door = (over: Partial<DoorRecord> = {}): DoorRecord => ({
  handle: 'drej',
  name: 'cookrew-alpha',
  title: 'COOKREW Alpha',
  door: 'Pilot',
  agents: 3,
  address: 'https://cookrew.dev/@drej/cookrew-alpha',
  transport: 'relay',
  access: 'paid',
  priceUsd: '2.50',
  rails: ['x402', 'stripe'],
  sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
  seenAt: 1,
  ...over
})

describe('a page is a document, not an app', () => {
  it('can express nothing at all — no script, no form, no handler', () => {
    for (const page of [
      homePage([door()]),
      handlePage('drej', [door()]),
      doorPage(door(), 'https://cookrew.dev')
    ]) {
      expect(page.body).not.toMatch(/<script/i)
      expect(page.body).not.toMatch(/<form/i)
      expect(page.body).not.toMatch(/\son[a-z]+=/i)
      expect(page.body).not.toMatch(/javascript:/i)
      // And it is told so, rather than merely happening not to contain one.
      expect(page.headers['content-security-policy']).toContain("script-src 'none'")
      expect(page.headers['content-security-policy']).toContain("form-action 'none'")
    }
  })

  it('escapes what an owner chose, because an owner chose it', () => {
    const hostile = door({
      title: '<img src=x onerror="alert(1)">',
      door: '"><script>alert(2)</script>'
    })
    const page = doorPage(hostile, 'https://cookrew.dev')
    expect(page.body).not.toContain('<img')
    expect(page.body).not.toContain('<script>')
    expect(page.body).toContain('&lt;img')
  })
})

describe('what a team’s page says', () => {
  it('names the door, the price and the rails — and the address to paste', () => {
    const page = doorPage(door(), 'https://cookrew.dev')
    expect(page.status).toBe(200)
    expect(page.body).toContain('COOKREW Alpha')
    expect(page.body).toContain('Pilot')
    expect(page.body).toContain('3 agents')
    expect(page.body).toContain('2.50 USD')
    expect(page.body).toContain('https://cookrew.dev/drej/cookrew-alpha')
    // Both rails, in words a reader owes nothing to understand.
    expect(page.body).toContain('USDC')
    expect(page.body).toContain('card')
  })

  it('never says where the author’s machine is', () => {
    // The record's `address` for a relayed door is already the published name,
    // but a LAN door's is not — and neither may reach a page.
    const page = doorPage(
      door({ transport: 'lan', address: 'http://192.168.2.40:8639/cookrew-alpha' }),
      'https://cookrew.dev'
    )
    expect(page.body).not.toContain('192.168')
    expect(page.body).not.toContain('8639')
  })

  it('never lists the roster — one door is the whole interface', () => {
    const page = doorPage(door({ agents: 9 }), 'https://cookrew.dev')
    // The COUNT is public; the names behind it are not, and there is nowhere
    // on this page they could come from.
    expect(page.body).toContain('9 agents')
    expect(page.body).toContain('never listed')
  })

  it('a free door still says an account is needed', () => {
    const page = doorPage(door({ access: 'account', priceUsd: undefined, rails: [] }), 'https://cookrew.dev')
    expect(page.body).toContain('free')
    expect(page.body).toContain('sign in')
    expect(page.body).not.toContain('2.50')
  })

  it('a door nobody serves answers like one that never existed', () => {
    const missing = doorPage(null, 'https://cookrew.dev')
    expect(missing.status).toBe(404)
    expect(missing.body).toContain('Not serving')
    // Said out loud, because it is the reason the page is vague.
    expect(missing.body).toContain('answer the same')
  })
})

describe('a listing is not a connection', () => {
  /**
   * The bug this exists for: a team stayed advertised as available while the
   * laptop it runs on had been shut for days. Somebody pasted the address,
   * was told nobody was serving it, and reasonably went to check the link.
   */
  it('says so when a listed team is not actually there', () => {
    const page = doorPage(door({ live: false }), 'https://cookrew.dev')
    expect(page.body).toContain('Not taking calls right now')
    // And the address is NOT withdrawn — it will work again.
    expect(page.body).toContain('stays valid')
    expect(page.body).toContain('https://cookrew.dev/drej/cookrew-alpha')
  })

  it('says nothing extra when it IS there', () => {
    const page = doorPage(door({ live: true }), 'https://cookrew.dev')
    expect(page.body).not.toContain('Not taking calls')
  })

  it('marks the offline ones in a list', () => {
    const page = handlePage('drej', [
      door({ live: true }),
      door({ name: 'research', title: 'Research Crew', live: false })
    ])
    expect(page.body).toContain('offline')
    // Exactly one of the two, not both.
    expect(page.body.match(/offline/g)).toHaveLength(1)
  })
})

describe('an owner’s page', () => {
  it('lists what they serve, and links each one', () => {
    const page = handlePage('drej', [door(), door({ name: 'research', title: 'Research Crew' })])
    expect(page.body).toContain('@drej')
    expect(page.body).toContain('2 teams')
    expect(page.body).toContain('/drej/cookrew-alpha')
    expect(page.body).toContain('/drej/research')
  })

  it('a handle serving nothing looks like a handle nobody took', () => {
    const page = handlePage('nobody', [])
    expect(page.status).toBe(404)
    expect(page.body).toContain('never taken')
  })
})

describe('the front page', () => {
  it('leads with the claim, and shows what is actually serving', () => {
    const page = homePage([door()])
    expect(page.body).toContain('Cookrew gives you a team')
    expect(page.body).toContain('COOKREW Alpha')
    expect(page.body).toContain('Serving right now')
  })

  it('says so plainly when nobody is serving', () => {
    const page = homePage([])
    expect(page.body).toContain('Nobody is serving a team here yet')
  })

  it('never claims a cut of anyone’s money', () => {
    // Whitespace-normalised: these sentences wrap in the source, and a test
    // that broke on a line break would be testing the formatter.
    const flat = homePage([door()]).body.replace(/\s+/g, ' ')
    expect(flat).toContain('straight to the author')
    expect(flat).toContain('this registry never holds it')
  })
})

describe('a handle cannot capture a route', () => {
  it('reserves every top-level name the registry answers on', () => {
    // An owner's page lives at /<handle>. Without this, a handle called `v1`
    // would shadow the API and one called `install` the install page.
    for (const taken of ['v1', 'install', 'api', '.well-known', 'robots.txt']) {
      expect(RESERVED_HANDLES.has(taken), taken).toBe(true)
    }
  })
})
