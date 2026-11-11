import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleGate, GATE_COPY, type GateDeps } from '../src/renderer/src/console/console-gate'
import { storageGrants, type Http } from '../src/renderer/src/account-pair-client'
import type { GrantOptions } from '../src/shared/account-pair'
import { memory } from './support/console-client'

/**
 * THE GATE (0.6.0): one proof, twelve hours, every machine.
 *
 * Before it, the console shows names and nothing else. The proof is a passkey
 * touched on this page, or the account password typed on auth.cookrew.dev: a
 * password is never typed here (decision F5), because this is the page that
 * draws what machines send it.
 */

const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const HOUR = 3_600_000
let clock = 1_800_000_000_000

const options = (over: Partial<GrantOptions> = {}): GrantOptions => ({
  methods: { password: true, passkey: true },
  needsPassword: false,
  passkey: { challenge: 'AAAA', rpId: 'cookrew.dev', timeout: 60_000, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: 'AQID' }] },
  ...over
})

const credential = (): Credential =>
  ({ id: 'AQID', type: 'public-key', response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer } }) as unknown as Credential

interface World {
  deps: GateDeps
  posts: { path: string; body: unknown }[]
  stored: ReturnType<typeof memory>
  elsewhere: string[]
}

const world = (over: { options?: GrantOptions | null; grant?: () => { status: number; body: unknown }; passkey?: GateDeps['passkey'] } = {}): World => {
  const posts: World['posts'] = []
  const stored = memory()
  const elsewhere: string[] = []
  const registry: Http = {
    get: async () => ({ status: 404, body: null }),
    post: async (path, body) => {
      posts.push({ path, body })
      if (path.endsWith('/options')) return over.options === null ? { status: 0, body: null } : { status: 200, body: over.options ?? options() }
      return over.grant?.() ?? { status: 201, body: { grant: 'a-pass', exp: clock + 12 * HOUR, deviceId: DEVICE } }
    }
  }
  return {
    posts,
    stored,
    elsewhere,
    deps: {
      registry,
      deviceId: async () => DEVICE,
      passkey: over.passkey === undefined ? async () => credential() : over.passkey,
      grants: storageGrants(stored),
      passwordElsewhere: async (returnTo) => {
        elsewhere.push(returnTo)
        return { ok: true }
      },
      now: () => clock
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_800_000_000_000
})
afterEach(() => vi.useRealTimers())

describe('before any proof', () => {
  it('is closed, and says how this account can open it', async () => {
    const w = world()
    const gate = createConsoleGate(w.deps)
    expect(gate.get().status).toBe('unknown')
    await gate.check()
    expect(gate.get()).toMatchObject({ status: 'closed', ways: { passkey: true, password: true }, line: null, busy: false })
  })

  it('an account with neither a password nor a passkey is told where to set one, and offered no button that cannot work', async () => {
    const w = world({ options: options({ methods: { password: false, passkey: false }, needsPassword: true, passkey: null }) })
    const gate = createConsoleGate(w.deps)
    await gate.check()
    expect(gate.get()).toMatchObject({ status: 'closed', ways: { passkey: false, password: false }, line: GATE_COPY.needsPassword })
  })

  it('a registry that does not answer is said plainly, and asked again on the next try', async () => {
    const w = world({ options: null })
    const gate = createConsoleGate(w.deps)
    await gate.check()
    expect(gate.get()).toMatchObject({ status: 'closed', ways: null, line: GATE_COPY.unreachable })
  })

  it('a browser that cannot use a passkey is offered the password only', async () => {
    const w = world({ passkey: null })
    const gate = createConsoleGate(w.deps)
    await gate.check()
    expect(gate.get()).toMatchObject({ status: 'closed', ways: { passkey: false, password: true } })
  })
})

describe('a passkey', () => {
  it('is touched here and opens the gate for twelve hours', async () => {
    const w = world()
    const gate = createConsoleGate(w.deps)
    await gate.check()
    const heard: string[] = []
    gate.subscribe(() => heard.push(gate.get().status))
    await gate.withPasskey()
    expect(gate.get()).toEqual({ status: 'open', until: clock + 12 * HOUR })
    expect(heard.at(-1)).toBe('open')
    // What went to the registry is the passkey's answer, and no password.
    const sent = w.posts.find((post) => post.path === '/v2/me/device-grant')
    expect(Object.keys(sent?.body as object)).toEqual(['credential'])
    expect(JSON.parse(w.stored.getItem('cr_grant') ?? '{}')).toMatchObject({ grant: 'a-pass', deviceId: DEVICE })
  })

  it('cancelled leaves the gate closed with nothing said against the person', async () => {
    const w = world({
      passkey: async () => {
        throw new DOMException('no', 'NotAllowedError')
      }
    })
    const gate = createConsoleGate(w.deps)
    await gate.check()
    await gate.withPasskey()
    expect(gate.get()).toMatchObject({ status: 'closed', line: null, busy: false })
    expect(w.posts.some((post) => post.path === '/v2/me/device-grant')).toBe(false)
  })

  it('refused says what the registry said, with a fresh challenge for the next touch', async () => {
    const w = world({ grant: () => ({ status: 401, body: { error: 'bad_credentials', message: 'That passkey did not answer.', triesLeft: 2 } }) })
    const gate = createConsoleGate(w.deps)
    await gate.check()
    await gate.withPasskey()
    expect(gate.get()).toMatchObject({ status: 'closed', line: 'That passkey did not answer.' })
    expect(w.posts.filter((post) => post.path.endsWith('/options'))).toHaveLength(2)
  })
})

describe('the password', () => {
  it('is never asked for here: the page goes to the auth host, naming where to come back', async () => {
    const w = world()
    const gate = createConsoleGate(w.deps)
    await gate.check()
    await gate.withPassword('/d/11111111-1111-4111-8111-111111111111')
    expect(w.elsewhere).toEqual(['/d/11111111-1111-4111-8111-111111111111'])
    // Nothing was posted for a pass from this page.
    expect(w.posts.some((post) => post.path === '/v2/me/device-grant')).toBe(false)
  })

  it('says why when the round trip could not start', async () => {
    const w = world()
    const gate = createConsoleGate({ ...w.deps, passwordElsewhere: async () => ({ ok: false, message: 'Sign in first.' }) })
    await gate.check()
    await gate.withPassword('/')
    expect(gate.get()).toMatchObject({ status: 'closed', line: 'Sign in first.', busy: false })
  })

  it('the pass it comes back with opens the gate, if it is for this browser’s key', async () => {
    const w = world()
    const gate = createConsoleGate(w.deps)
    await gate.check()
    await gate.took({ grant: 'from-the-auth-host', exp: clock + 12 * HOUR, deviceId: DEVICE })
    expect(gate.get()).toEqual({ status: 'open', until: clock + 12 * HOUR })
    const other = createConsoleGate(world().deps)
    await other.check()
    await other.took({ grant: 'for-another-key', exp: clock + 12 * HOUR, deviceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
    expect(other.get().status).toBe('closed')
  })
})

describe('a pass already held', () => {
  it('opens the gate without asking anyone anything', async () => {
    const w = world()
    w.stored.setItem('cr_grant', JSON.stringify({ grant: 'held', exp: clock + 5 * HOUR, deviceId: DEVICE }))
    const gate = createConsoleGate(w.deps)
    await gate.check()
    expect(gate.get()).toEqual({ status: 'open', until: clock + 5 * HOUR })
    expect(w.posts).toEqual([])
  })

  it('held for another key, or about to end, is no pass', async () => {
    for (const held of [
      { grant: 'held', exp: clock + 5 * HOUR, deviceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      { grant: 'held', exp: clock + 30_000, deviceId: DEVICE }
    ]) {
      const w = world()
      w.stored.setItem('cr_grant', JSON.stringify(held))
      const gate = createConsoleGate(w.deps)
      await gate.check()
      expect(gate.get().status).toBe('closed')
    }
  })

  it('closes by itself when the twelve hours are up, with the page still open', async () => {
    const w = world()
    w.stored.setItem('cr_grant', JSON.stringify({ grant: 'held', exp: clock + HOUR, deviceId: DEVICE }))
    const gate = createConsoleGate(w.deps)
    await gate.check()
    expect(gate.get().status).toBe('open')
    clock += HOUR
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(gate.get().status).toBe('closed')
  })

  it('is let go of on sign-out, and by nothing a machine says', async () => {
    const w = world()
    const gate = createConsoleGate(w.deps)
    expect('reproof' in gate).toBe(false)
    w.stored.setItem('cr_grant', JSON.stringify({ grant: 'held', exp: clock + 5 * HOUR, deviceId: DEVICE }))
    await gate.check()
    expect(gate.get().status).toBe('open')
    gate.forget()
    expect(gate.get().status).toBe('unknown')
    expect(w.stored.getItem('cr_grant')).toBeNull()
  })
})
