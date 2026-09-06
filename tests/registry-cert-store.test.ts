import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CertStore,
  IN_FLIGHT_MAX_MS,
  ORDERS_PER_DAY,
  RENEW_WITHIN_MS,
  notAfterOf
} from '../registry/src/cert-store'
import { ecPair, issueLeaf, makeCa, makeCsr, spkiFromCsr } from './support/x509-forge'

/**
 * THE LEDGER BEHIND THE CERT ROUTE, driven by a clock a test can move.
 *
 * The route's limits are hours and days long, so the only honest way to test
 * them is with an injected clock — and they are the limits that decide whether
 * one Mac in a retry loop can spend the whole account's weekly allowance at
 * Let's Encrypt. The renewal window is here for the same reason: it is what
 * stops a daily cron from ordering a new certificate every day.
 */

const MAC = 'abcd1234-aaaa-bbbb-cccc-000000000001'
const NAME = `*.${MAC}.d.cookrew.dev`
const HOUR = 60 * 60 * 1000
const ca = makeCa()

let clock = 1_757_000_000_000
let dir = ''
const dirs: string[] = []

const store = (): CertStore => {
  dir = mkdtempSync(path.join(tmpdir(), 'cert-store-'))
  dirs.push(dir)
  return new CertStore(dir, () => clock)
}

const chainFor = (daysLeft: number): string =>
  issueLeaf({
    ca,
    spki: spkiFromCsr(makeCsr({ pair: ecPair(), names: [NAME] })),
    names: [NAME],
    serial: 1,
    notBefore: new Date(clock - HOUR),
    notAfter: new Date(clock + daysLeft * 24 * HOUR)
  })

beforeEach(() => {
  clock = 1_757_000_000_000
})

afterAll(() => {
  for (const one of dirs) rmSync(one, { recursive: true, force: true })
})

describe('the rate ledger', () => {
  it('allows one order an hour and five a day, and says how long to wait', () => {
    const certs = store()
    expect(certs.mayOrder(MAC).ok).toBe(true)
    certs.beginOrder(MAC, 'order-1')
    const refused = certs.mayOrder(MAC)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.retryAfter).toBeGreaterThan(3500)
    expect(refused.retryAfter).toBeLessThanOrEqual(3600)

    // An hour later the next one is allowed, up to five in a day.
    for (let i = 1; i < ORDERS_PER_DAY; i += 1) {
      clock += HOUR + 1000
      expect(certs.mayOrder(MAC).ok).toBe(true)
      certs.beginOrder(MAC, `order-${i + 1}`)
    }
    clock += HOUR + 1000
    const daily = certs.mayOrder(MAC)
    expect(daily.ok).toBe(false)
    if (!daily.ok) expect(daily.retryAfter).toBeGreaterThan(0)

    // A day after the first, the window has rolled and it is allowed again.
    clock += 20 * HOUR
    expect(certs.mayOrder(MAC).ok).toBe(true)
  })

  it('survives a restart, because that is the only thing it is for', () => {
    const certs = store()
    certs.beginOrder(MAC, 'order-1')
    const again = new CertStore(dir, () => clock)
    expect(again.mayOrder(MAC).ok).toBe(false)
    // ...and the in-flight mark does NOT survive, because the order did not.
    expect(again.state(MAC).status).toBe('none')
  })

  it('does not hold the door shut for an order whose client died', () => {
    const certs = store()
    certs.beginOrder(MAC, 'order-1')
    expect(certs.state(MAC).status).toBe('pending')
    clock += IN_FLIGHT_MAX_MS + 1000
    expect(certs.state(MAC).status).toBe('none')
  })
})

describe('what a chain is worth', () => {
  it('reads notAfter out of the leaf rather than trusting anyone about it', () => {
    const certs = store()
    const chain = chainFor(90)
    const issued = certs.settle(MAC, chain)
    expect(issued).not.toBeNull()
    expect(issued!.notAfter).toBe(notAfterOf(chain))
    expect(certs.hasNames(MAC)).toBe(true)
    expect(certs.state(MAC)).toMatchObject({ status: 'issued', chain })
    // It outlives the process.
    expect(new CertStore(dir, () => clock).hasNames(MAC)).toBe(true)
  })

  it('refuses to store something that is not a certificate, and says why', () => {
    const certs = store()
    expect(certs.settle(MAC, 'not a certificate')).toBeNull()
    expect(certs.state(MAC)).toMatchObject({ status: 'failed' })
    expect(certs.hasNames(MAC)).toBe(false)
  })

  it('is fresh until the renewal window, and expired after notAfter', () => {
    const certs = store()
    certs.settle(MAC, chainFor(90))
    expect(certs.fresh(MAC)).not.toBeNull()
    // One day inside the 30-day window: still issued, no longer fresh.
    clock += 90 * 24 * HOUR - RENEW_WITHIN_MS + 1000
    expect(certs.fresh(MAC)).toBeNull()
    expect(certs.hasNames(MAC)).toBe(true)
    // Past notAfter it is not a certificate this Mac has at all.
    clock += RENEW_WITHIN_MS
    expect(certs.hasNames(MAC)).toBe(false)
    expect(certs.state(MAC).status).toBe('none')
  })
})

describe('the challenge table', () => {
  it('lives in memory only, and is cleared by whichever way the order ends', () => {
    const certs = store()
    certs.publish(MAC, ['a-digest'])
    expect(certs.textsFor(MAC)).toEqual(['a-digest'])
    // A new store over the same directory has never heard of it.
    expect(new CertStore(dir, () => clock).textsFor(MAC)).toEqual([])
    certs.settle(MAC, chainFor(90))
    expect(certs.textsFor(MAC)).toEqual([])
    certs.publish(MAC, ['another'])
    certs.fail(MAC, 'rejected')
    expect(certs.textsFor(MAC)).toEqual([])
  })

  it('moves the zone’s serial whenever anything it answers with changes', () => {
    const certs = store()
    const before = certs.changedAt()
    clock += 5000
    certs.publish(MAC, ['a-digest'])
    expect(certs.changedAt()).toBeGreaterThan(before)
  })
})

/**
 * H4 — THE CEILING THE PER-DEVICE LIMITS CANNOT SEE.
 *
 * Let's Encrypt counts fifty new certificates per REGISTERED DOMAIN per week,
 * and cookrew.dev is one registered domain — so every `*.<id>.d.cookrew.dev`
 * comes out of the same allowance as cookrew.dev's own renewal. One an hour
 * per device is a limit on a device; fifty devices each taking their one an
 * hour spend the site's certificate in an afternoon, and the site's is the one
 * nobody can order by hand at three in the morning.
 */
describe('the weekly budget, across every Mac', () => {
  const budgeted = (weekly: number): CertStore => {
    dir = mkdtempSync(path.join(tmpdir(), 'cert-budget-'))
    dirs.push(dir)
    return new CertStore(dir, () => clock, () => undefined, weekly)
  }

  it('refuses an order past the budget, whoever is asking and however clean their record', () => {
    const certs = budgeted(3)
    for (let i = 0; i < 3; i += 1) {
      const device = `mac-${i}`
      expect(certs.mayOrder(device).ok).toBe(true)
      certs.beginOrder(device, `order-${i}`)
    }
    expect(certs.ordersThisWeek()).toBe(3)
    // A Mac that has never asked for anything is still refused: the allowance
    // is the registry's, not the device's.
    const fresh = certs.mayOrder('mac-never-seen')
    expect(fresh.ok).toBe(false)
    if (!fresh.ok) {
      expect(fresh.retryAfter).toBeGreaterThan(0)
      // Until the oldest of the three ages out of the week, and no longer.
      expect(fresh.retryAfter).toBeLessThanOrEqual(7 * 24 * 60 * 60)
    }
  })

  it('lets the window roll rather than latching shut', () => {
    const certs = budgeted(2)
    certs.beginOrder('mac-a', 'one')
    clock += 3 * 24 * HOUR
    certs.beginOrder('mac-b', 'two')
    expect(certs.mayOrder('mac-c').ok).toBe(false)
    // Eight days after the first, four after the second: one slot is free.
    clock += 5 * 24 * HOUR
    expect(certs.ordersThisWeek()).toBe(1)
    expect(certs.mayOrder('mac-c').ok).toBe(true)
  })

  it('survives the restart it exists to survive', () => {
    const certs = budgeted(2)
    certs.beginOrder('mac-a', 'one')
    certs.beginOrder('mac-b', 'two')
    expect(certs.mayOrder('mac-c').ok).toBe(false)
    // A restart that forgot the ledger would hand the CA a fresh allowance,
    // which is exactly the loop that gets an account rate-limited for a week.
    const reopened = new CertStore(dir, () => clock, () => undefined, 2)
    expect(reopened.ordersThisWeek()).toBe(2)
    expect(reopened.mayOrder('mac-c').ok).toBe(false)
  })

  it('rebuilds the week from a file written before the ledger existed', () => {
    const certs = budgeted(2)
    certs.beginOrder('mac-a', 'one')
    // A file from the old shape: per-device records, no global list.
    const file = path.join(dir, 'certs.json')
    const held = JSON.parse(readFileSync(file, 'utf8')) as { orders?: number[] }
    delete held.orders
    writeFileSync(file, JSON.stringify(held))
    const reopened = new CertStore(dir, () => clock, () => undefined, 2)
    expect(reopened.ordersThisWeek()).toBe(1)
  })

  it('leaves the per-device limits saying what they always said', () => {
    const certs = budgeted(100)
    expect(certs.mayOrder(MAC).ok).toBe(true)
    certs.beginOrder(MAC, 'one')
    const soon = certs.mayOrder(MAC)
    expect(soon.ok).toBe(false)
    // An hour, not a week: the specific answer and the short wait.
    if (!soon.ok) expect(soon.retryAfter).toBeLessThanOrEqual(60 * 60)
  })
})
