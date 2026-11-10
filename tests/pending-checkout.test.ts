import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { PendingCheckouts, pendingCheckoutsPath, type PendingCheckout } from '../src/main/pending-checkout'

/**
 * A CARD PAYMENT IN FLIGHT, REMEMBERED ON DISK (D).
 *
 * The door makes a Checkout session and from then on a card can be charged on
 * it for up to an hour — whether or not the sheet that started it is still
 * open. Held only in a component's state, a closed sheet forgot it: the next
 * PAY across the door's quote window made a SECOND session (two charges), and
 * a session paid after the sheet closed was never presented (paid, no seat).
 * So main remembers it per account and door, in a file, until the door has
 * answered for it.
 */

const dirs: string[] = []
const base = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pending-checkout-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const entry = (over: Partial<PendingCheckout> = {}): PendingCheckout => ({
  account: 'lin',
  door: '@drej/alpha',
  link: '@drej/alpha',
  session: 'cs_test_one',
  url: 'https://checkout.stripe.com/c/pay/cs_test_one',
  price: '1.00',
  startedAt: 1_700_000_000_000,
  ...over
})

describe('PendingCheckouts', () => {
  it('remembers one session per account and door, across instances — an app restart forgets nothing', () => {
    const dir = base()
    new PendingCheckouts({ base: dir }).put(entry())
    const again = new PendingCheckouts({ base: dir })
    expect(again.get('lin', '@drej/alpha')).toEqual(entry())
    expect(again.get('bo', '@drej/alpha')).toBeNull()
    expect(again.get('lin', '@drej/beta')).toBeNull()
    expect(again.all('lin')).toEqual([entry()])
    expect(again.all('bo')).toEqual([])
  })

  it('is private to this user, and holds a session id and an address — never a credential', () => {
    const dir = base()
    new PendingCheckouts({ base: dir }).put(entry())
    const file = pendingCheckoutsPath(dir)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, 'utf8')
    expect(Object.keys(JSON.parse(text)[0]).sort()).toEqual(['account', 'door', 'link', 'price', 'session', 'startedAt', 'url'])
    expect(text).not.toMatch(/token|bearer|secret|key/i)
  })

  it('a served seat cannot read whose payments are in flight', () => {
    const denied = ownerSecretPaths('/Users/owner/.cookrew', '/Users/owner')
    expect(denied).toEqual(
      expect.arrayContaining(['/Users/owner/.cookrew/checkout-pending.json', '/Users/owner/.cookrew/checkout-pending.json.tmp'])
    )
    expect(pendingCheckoutsPath('/Users/owner/.cookrew')).toBe('/Users/owner/.cookrew/checkout-pending.json')
  })

  it('drops only the session it was told about: a newer one for the same door is not lost to a late answer', () => {
    const dir = base()
    const store = new PendingCheckouts({ base: dir })
    store.put(entry())
    store.put(entry({ session: 'cs_test_two', url: 'https://checkout.stripe.com/c/pay/cs_test_two' }))
    expect(store.all('lin')).toHaveLength(1)
    store.drop('lin', '@drej/alpha', 'cs_test_one')
    expect(store.get('lin', '@drej/alpha')?.session).toBe('cs_test_two')
    store.drop('lin', '@drej/alpha', 'cs_test_two')
    expect(store.get('lin', '@drej/alpha')).toBeNull()
  })

  it('reads nothing out of a file it did not write: a bad address, a bad session, a wrong shape', () => {
    const dir = base()
    writeFileSync(
      pendingCheckoutsPath(dir),
      JSON.stringify([
        entry({ url: 'file:///Applications/Calculator.app#/cs_test_one' }),
        entry({ account: 'bo', session: 'not-a-session' }),
        entry({ account: 'cy', url: 'https://checkout.stripe.com/c/pay/cs_test_other' }),
        { account: 'di' },
        'nonsense',
        entry({ account: 'ok' })
      ]),
      { mode: 0o600 }
    )
    const store = new PendingCheckouts({ base: dir })
    for (const account of ['lin', 'bo', 'cy', 'di']) expect(store.all(account), account).toEqual([])
    expect(store.all('ok')).toHaveLength(1)
    // And a file that is not JSON at all is an empty memory, not a crash.
    writeFileSync(pendingCheckoutsPath(dir), '{{{')
    expect(new PendingCheckouts({ base: dir }).all('ok')).toEqual([])
  })
})
