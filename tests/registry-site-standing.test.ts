import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lineFace, standingOf, type Standing } from '../registry/src/site-standing'
import { homePage, teamPage, type ListedDoor } from '../registry/src/site'
import { page } from '../registry/src/site-shell'

/**
 * ONE STANDING, DECIDED ONCE, RENDERED EVERYWHERE.
 *
 * A team page used to have two brains. The seat bar was rendered on the server
 * from what the request held — it knew the reader was @drej and that @drej
 * owned the team — while the LINE under it was rendered blind: SIGNED OUT,
 * "Sign in to open your own session", a gate card saying "🔑 Sign in & open",
 * for everyone, the owner included. And the owner's seat bar had no Open
 * button at all. So the owner, told by half the page to sign in and shown a
 * "Grant a seat" form by the other half, typed their own username into it and
 * granted themselves a seat — for a team the registry already admits them to
 * with no seat (v2-seat-routes: an owner never needs one).
 *
 * The header had the same problem one level up: a document page carries no
 * script by design, so it could never learn who was reading, and the front
 * page said "Sign in" to a person who was.
 *
 * So there is one function that decides what a reader IS at a team — stranger,
 * owner, seated, admitted, unseated — and one that turns that into what the
 * line says. The seat bar, the line's chip, the strip sentence and the gate
 * card all read them. Nothing on the page may disagree with anything else on
 * it, because nothing has a second source to disagree from.
 */

const door = (over: Partial<ListedDoor> = {}): ListedDoor => ({
  handle: 'drej',
  name: 'cookrew-alpha',
  title: 'COOKREW Alpha',
  door: 'Pilot',
  agents: 3,
  address: 'https://cookrew.dev/@drej/cookrew-alpha',
  transport: 'relay',
  access: 'paid',
  priceUsd: '1',
  rails: ['stripe'],
  sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
  seenAt: 1,
  ...over
})

const seat = { id: 's1', team: '@drej/cookrew-alpha', account: 'mira', source: 'granted' as const, by: 'drej', createdAt: 1_760_000_000_000 }

describe('what a reader is at a team', () => {
  it('a stranger is a stranger, whatever the team charges', () => {
    expect(standingOf({ account: null }, door())).toEqual({ kind: 'stranger' })
    expect(standingOf({ account: null }, door({ access: 'account' }))).toEqual({ kind: 'stranger' })
  })

  it('the owner is the owner — no seat, no charge, at their own team', () => {
    expect(standingOf({ account: 'drej', owner: true }, door())).toEqual({ kind: 'owner', account: 'drej' })
    // The name alone is what makes an owner; the flag is the server saying so.
    expect(standingOf({ account: 'drej', owner: true, seat }, door()).kind).toBe('owner')
  })

  it('a seat held is a seat held, with when it began', () => {
    expect(standingOf({ account: 'mira', seat }, door())).toEqual({ kind: 'seated', account: 'mira', since: seat.createdAt })
  })

  it('a free team admits anyone signed in — registering is the gate', () => {
    expect(standingOf({ account: 'mira' }, door({ access: 'account', priceUsd: undefined }))).toEqual({ kind: 'admitted', account: 'mira' })
  })

  it('a priced team with no seat is unseated, and says the price', () => {
    expect(standingOf({ account: 'mira' }, door())).toEqual({ kind: 'unseated', account: 'mira', price: '1' })
  })
})

describe('what the line says', () => {
  const at = { name: '@drej/cookrew-alpha', orch: 'Pilot', handle: 'drej', live: true, relayed: true, price: '1' }
  const says = (standing: Standing) => lineFace(standing, at)

  it('to a stranger: signed out, and the gate is the way in', () => {
    const face = says({ kind: 'stranger' })
    expect(face.phase).toBe('SIGNED OUT')
    expect(face.state).toMatch(/sign in/i)
    expect(face.gate.button).toMatch(/sign in/i)
    expect(face.gate.disabled).toBe(false)
  })

  it('to the owner: yours, and the gate opens the line — not a sign-in', () => {
    const face = says({ kind: 'owner', account: 'drej' })
    expect(face.phase).toBe('YOURS')
    expect(face.state).toMatch(/your own team/i)
    expect(face.state).not.toMatch(/sign in/i)
    expect(face.gate.button).toBe('Open the line')
    expect(face.gate.text).not.toMatch(/sign in/i)
  })

  it('to somebody seated: seated since when, and the gate opens the line', () => {
    const face = says({ kind: 'seated', account: 'mira', since: seat.createdAt })
    expect(face.phase).toBe('SEATED')
    expect(face.state).toMatch(/seat since/i)
    expect(face.gate.button).toBe('Open the line')
  })

  it('to somebody admitted to a free team: signed in, and the gate opens the line', () => {
    const face = says({ kind: 'admitted', account: 'mira' })
    expect(face.phase).toBe('SIGNED IN')
    expect(face.state).toMatch(/charges nothing/i)
    expect(face.gate.button).toBe('Open the line')
  })

  it('to somebody unseated: no seat, the price, and NEVER a sign-in — they are signed in', () => {
    const face = says({ kind: 'unseated', account: 'mira', price: '1' })
    expect(face.phase).toBe('NO SEAT')
    expect(face.state).toMatch(/seat/i)
    expect(face.state).not.toMatch(/sign in/i)
    expect(face.gate.title).toMatch(/seat/i)
    expect(face.gate.text).toContain('@drej')
    expect(face.gate.button).toMatch(/buy a seat/i)
  })

  it('offline beats every standing: nobody is serving, and the gate is disabled', () => {
    for (const standing of [{ kind: 'stranger' }, { kind: 'owner', account: 'drej' }] as const) {
      const face = lineFace(standing, { ...at, live: false })
      expect(face.phase).toBe('OFFLINE')
      expect(face.state).toMatch(/nobody is serving/i)
      expect(face.gate.disabled).toBe(true)
    }
  })

  it('a door off the relay is opened in the app, whoever is reading', () => {
    const face = lineFace({ kind: 'owner', account: 'drej' }, { ...at, relayed: false })
    expect(face.phase).toBe('IN THE APP')
    expect(face.gate.disabled).toBe(true)
  })
})

describe('the team page has one brain', () => {
  const render = (over: Partial<Parameters<typeof teamPage>[0]>) =>
    teamPage({ door: door(), origin: 'https://cookrew.dev', stars: 0, starred: false, account: null, ...over }).body

  it('the owner is offered the line in the seat bar AND the line agrees below', () => {
    const body = render({ account: 'drej', owner: true, seats: [], seated: [] })
    expect(body).toContain('data-seat-open')
    expect(body).toContain('id="phase">YOURS<')
    expect(body).not.toContain('SIGNED OUT')
    expect(body).not.toContain('Sign in &amp; open')
    expect(body).not.toContain('Sign in to open your own session')
    // The grant form is still there for guests — it is just no longer the
    // only thing an owner can press.
    expect(body).toContain('Grant a seat')
  })

  it('a seated guest reads SEATED, and a stranger still reads SIGNED OUT', () => {
    expect(render({ account: 'mira', seat })).toContain('id="phase">SEATED<')
    expect(render({ account: null })).toContain('id="phase">SIGNED OUT<')
  })

  it('an unseated guest is never told to sign in — they did', () => {
    const body = render({ account: 'mira' })
    expect(body).toContain('id="phase">NO SEAT<')
    expect(body).not.toContain('Sign in &amp; open')
    expect(body).toContain('Buy a seat')
  })
})

describe('the header knows who is reading, on every kind of page', () => {
  it('a document page names the account without a script — a link to /me', () => {
    const body = page({ title: 't', kind: 'document', account: 'drej' }, '<p>x</p>').body
    expect(body).toContain('href="/me"')
    expect(body).toContain('@drej')
    expect(body).not.toMatch(/ Sign in<\/(?:a|button)>/)
    expect(body).not.toMatch(/<script(?! type="application\/ld\+json")/i)
  })

  it('an app page names the account too, and the button still goes to /me', () => {
    const body = page({ title: 't', kind: 'app', account: 'drej' }, '<p>x</p>').body
    expect(body).toContain('@drej')
    expect(body).toContain('data-signin="me"')
  })

  it('a stranger is offered sign in, as before', () => {
    expect(page({ title: 't', kind: 'document' }, '<p>x</p>').body).toMatch(/ Sign in<\/a>/)
    expect(page({ title: 't', kind: 'app', account: null }, '<p>x</p>').body).toMatch(/ Sign in<\/button>/)
  })

  it('the front page for a signed-in reader is theirs — private, never shared from a cache', () => {
    const input = { doors: [], presets: [], release: null, stars: () => 0, pulse: () => ({ lines: 0, calls: 0 }), linesToday: 0 }
    const mine = homePage({ ...input, account: 'drej' })
    expect(mine.body).toContain('@drej')
    expect(mine.headers['cache-control']).toBe('private, no-store')
    const anyone = homePage(input)
    expect(anyone.body).toMatch(/ Sign in<\/a>/)
    expect(anyone.headers['cache-control']).toMatch(/^public/)
  })
})

describe('the line script, when the registry refuses a seat', () => {
  const line = readFileSync(path.join(__dirname, '../registry/assets/line.js'), 'utf8')

  it('tells a signed-in person they have no seat, rather than opening the sign-in sheet', () => {
    // 401 is "nobody is signed in here" and the sheet is the answer. 403 is
    // "you are, and you hold no seat" — and a sign-in sheet shown to a person
    // who is signed in is the exact confusion this whole change removes.
    expect(line).toMatch(/status === 403/)
    expect(line).toContain("'no-seat'")
    // The old shape swallowed every refusal into "not signed in" — a 403
    // became null, and null opened the sheet.
    expect(line).not.toContain('v2CallToken().catch(() => null)')
  })
})
