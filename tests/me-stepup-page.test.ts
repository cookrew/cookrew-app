import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { mePage } from '../registry/src/site-account'
import type { V2Account } from '../registry/src/v2-accounts'
import { El, MiniDocument, parseHtml } from './support/mini-dom'

/**
 * cookrew.dev/me, FOR AN ACCOUNT WITH NO PASSWORD (me-stepup, 11-09).
 *
 * The real /me markup and the real scripts, in a DOM where `replaceChildren`
 * detaches. What is asserted is the flow a person meets: every sensitive
 * button either does its act or takes them to auth.cookrew.dev for that act,
 * and the way back finishes it — with the form kept where that is safe, and
 * never a password across the trip.
 */

const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'registry', 'assets', name), 'utf8')
const SCRIPTS = ['device-id.js', 'step-up.js', 'site.js', 'factors.js'].map(read)
const PROOF = '0b5e3c8a-1d2f-4a6b-8c9d-0e1f2a3b4c5d'
const NEXT = 'a long new account password'

const account = (passwordless: boolean): V2Account => ({
  username: 'anvztor',
  ...(passwordless ? { passwordless: true } : { password: { salt: 'x', hash: 'y' } }),
  displayName: 'Andrej',
  avatar: null,
  claimedAt: Date.parse('2026-09-01T00:00:00Z'),
  devices: [
    { id: '11111111-2222-4333-8444-555555555555', kind: 'browser', name: 'Chrome on macOS', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'zz' }, addedAt: 0, lastSeenAt: 0 },
    { id: '66666666-2222-4333-8444-555555555555', kind: 'desktop', name: 'Studio Mac', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'yy' }, addedAt: 0, lastSeenAt: 0 }
  ],
  desktops: [],
  sessions: [],
  recovery: [],
  revoked: []
} as unknown as V2Account)

/** The page lives on the auth host only (0.6.0): it is always drawn standalone. */
const STANDALONE = { site: 'https://cookrew.dev', console: 'https://console.cookrew.dev', home: '/account' }
type Answer = { status: number; body?: unknown }
type Route = (method: string, url: string, body: Record<string, unknown>) => Answer | undefined

interface Page {
  doc: MiniDocument
  calls: { method: string; url: string; body: Record<string, unknown> }[]
  trips: { intent: string; extra: unknown }[]
  toasts: string[]
  prompts: string[]
  storage: Map<string, string>
  replaced: string[]
  errors: unknown[]
  settle: () => Promise<void>
  find: (selector: string) => El[]
  press: (selector: string) => void
  words: () => string
  land: () => Promise<void>
}

const STEP_UP = { status: 401, body: { error: 'step_up', message: 'Prove it is you before deleting this account.', next: ['totp'] } }

/** /me with the scripts over it; `route` answers the registry, `answers` the browser's own dialogs. */
function openMe(options: {
  passwordless?: boolean
  route: Route
  search?: string
  hash?: string
  stored?: Record<string, string>
  password?: string | null
  /** What site.js's trip answers: true (leaving), 'refused' (said already), false (no auth page). */
  trip?: boolean | 'refused'
}): Page {
  const doc = new MiniDocument()
  const rendered = mePage({ account: account(options.passwordless ?? true), currentDeviceId: '11111111-2222-4333-8444-555555555555' }, STANDALONE)
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(rendered.body)?.[1] ?? ''
  for (const node of parseHtml(body, doc)) doc.body.append(node)
  const calls: Page['calls'] = []
  const trips: Page['trips'] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const replaced: string[] = []
  const errors: unknown[] = []
  const storage = new Map<string, string>(Object.entries(options.stored ?? {}))
  const location = {
    hash: options.hash ?? '',
    origin: 'https://cookrew.dev',
    hostname: 'cookrew.dev',
    protocol: 'https:',
    pathname: '/me',
    search: options.search ?? '',
    assign: (url: string) => calls.push({ method: 'ASSIGN', url, body: {} }),
    reload: () => calls.push({ method: 'RELOAD', url: '', body: {} })
  }
  const sandbox: Record<string, unknown> = {
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140' },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key)
    },
    indexedDB: {
      open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }),
      deleteDatabase: () => ({ onsuccess: null, onerror: null, onblocked: null })
    },
    history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    confirm: () => true,
    prompt: (question: string) => {
      prompts.push(question)
      return options.password ?? null
    },
    location,
    addEventListener: () => undefined,
    document: doc,
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const sent = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      calls.push({ method, url, body: sent })
      const answer = options.route(method, url, sent) ?? (url === '/v2/me/requests' ? { status: 200, body: [] } : { status: 404, body: { error: 'not_found' } })
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body ?? {} }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  for (const script of SCRIPTS) vm.runInNewContext(script, sandbox)
  // The trip itself (device key, transcript, navigation) is site.js's and its own suite's.
  const account_ = sandbox.cookrewAccount as Record<string, unknown>
  sandbox.cookrewAccount = {
    ...account_,
    toast: (message: string) => toasts.push(message),
    throughAuthSite: async (intent: string, extra: unknown) => {
      trips.push({ intent, extra })
      return options.trip ?? true
    }
  }
  const settle = async (): Promise<void> => {
    for (let at = 0; at < 12; at += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return {
    doc,
    calls,
    trips,
    toasts,
    prompts,
    storage,
    replaced,
    errors,
    settle,
    find: (selector) => doc.querySelectorAll(selector),
    press: (selector) => {
      const node = doc.querySelectorAll(selector)[0]
      expect(node, selector).toBeDefined()
      node.dispatch('click')
    },
    words: () => doc.body.textContent,
    land: async () => {
      for (const handler of doc.handlersFor('DOMContentLoaded')) handler({} as never)
      await settle()
    }
  }
}

const sent = (page: Page, method: string, url: string) => page.calls.filter((c) => c.method === method && c.url === url)
const saved = (page: Page): { act: string; resume: Record<string, unknown> } => JSON.parse(page.storage.get('cr_stepup') ?? 'null')
const type = (field: El, value: string): void => {
  field.value = value
  field.dispatch('input')
}
const passwordFields = (page: Page): El[] => page.find('#me-password input')

describe('setting a first password on /me', () => {
  it('within five minutes of a verification, opens the fields at once', async () => {
    const page = openMe({ route: (m, u) => (u === '/v2/me/step-up/change-password' ? { status: 200, body: { fresh: true } } : undefined) })
    page.press('[data-password]')
    await page.settle()
    // A first password: the new one and it again — there is no current one.
    expect(passwordFields(page)).toHaveLength(2)
    expect(page.trips).toEqual([])
  })

  it('after them, says what happens and goes to auth.cookrew.dev before anything is typed', async () => {
    const page = openMe({ route: (m, u) => (u === '/v2/me/step-up/change-password' ? { status: 200, body: { fresh: false } } : undefined) })
    page.press('[data-password]')
    await page.settle()
    // No field to type a password into: it would be thrown away by the trip.
    expect(page.find('#me-password input[type="password"]')).toHaveLength(0)
    expect(page.words()).toContain('First, confirm it is you')
    expect(page.find('[data-step-up]')[0]?.dataset.stepUp).toBe('change-password')
    page.press('[data-step-up]')
    await page.settle()
    expect(page.trips).toEqual([{ intent: 'step-up', extra: { act: 'change-password' } }])
    expect(saved(page)).toMatchObject({ act: 'change-password', resume: { kind: 'password' } })
  })

  it('back from the trip, opens the fields and sets the password with the proof it earned', async () => {
    const page = openMe({
      search: '?stepped=change-password',
      hash: `#stepup=${PROOF}`,
      stored: { cr_stepup: JSON.stringify({ act: 'change-password', resume: { kind: 'password' }, at: Date.now() }) },
      route: (m, u) => (m === 'POST' && u === '/v2/me/password' ? { status: 204 } : undefined)
    })
    await page.land()
    // The proof is out of the address bar before anything else happens.
    expect(page.replaced).toEqual(['/me'])
    expect(page.storage.has('cr_stepup')).toBe(false)
    expect(page.words()).toContain('Confirmed. Choose your password now')
    const [next, again] = passwordFields(page).slice(-2)
    type(next, NEXT)
    type(again, NEXT)
    page.find('#me-password button')[0].dispatch('click')
    await page.settle()
    expect(sent(page, 'POST', '/v2/me/password').map((c) => c.body)).toEqual([{ next: NEXT, stepUp: PROOF }])
    expect(page.toasts).toContain('Password set. Your machines take it now.')
  })

  it('a landing this tab did not start finishes nothing, and says what to do', async () => {
    const page = openMe({ search: '?stepped=delete-account', hash: `#stepup=${PROOF}`, route: () => undefined })
    await page.land()
    expect(page.replaced).toEqual(['/me'])
    expect(sent(page, 'DELETE', '/v2/me')).toEqual([])
    expect(page.toasts.join(' ')).toMatch(/five minutes/)
  })

  it('a landing for another act than the one started finishes nothing', async () => {
    const page = openMe({
      search: '?stepped=delete-account',
      hash: `#stepup=${PROOF}`,
      stored: { cr_stepup: JSON.stringify({ act: 'add-factor', resume: { kind: 'recovery' }, at: Date.now() }) },
      route: () => undefined
    })
    await page.land()
    expect(sent(page, 'POST', '/v2/me/recovery-codes')).toEqual([])
  })
})

describe('a trip the registry refuses', () => {
  it('keeps the page where it was: Continue works again and nothing waits for a landing', async () => {
    const page = openMe({ trip: 'refused', route: (m, u) => (u === '/v2/me/step-up/change-password' ? { status: 200, body: { fresh: false } } : undefined) })
    page.press('[data-password]')
    await page.settle()
    page.press('[data-step-up]')
    await page.settle()
    expect(page.trips).toHaveLength(1)
    expect(page.find('[data-step-up]')[0].disabled).toBe(false)
    expect(page.storage.has('cr_stepup')).toBe(false)
    // The refusal was said by site.js; nothing is said twice.
    expect(page.toasts).toEqual([])
  })

  it('a registry that answers the password with a refusal sends the panel to the trip, not round again', async () => {
    const page = openMe({
      route: (m, u) =>
        u === '/v2/me/step-up/change-password'
          ? { status: 404, body: {} }
          : m === 'POST' && u === '/v2/me/password'
            ? { status: 403, body: { error: 'step_up', message: 'Prove it is you first.' } }
            : undefined
    })
    page.press('[data-password]')
    await page.settle()
    const [next, again] = passwordFields(page)
    type(next, NEXT)
    type(again, NEXT)
    page.find('#me-password button')[0].dispatch('click')
    await page.settle()
    expect(page.find('[data-step-up]')).toHaveLength(1)
    expect(passwordFields(page)).toHaveLength(0)
  })
})

describe('deleting an account with no password', () => {
  it('asks only for the name, never sends anyone to the desktop app', async () => {
    const page = openMe({ route: () => undefined })
    expect(page.find('#me-delete-password')).toHaveLength(0)
    expect(page.words()).not.toMatch(/Cookrew app/)
    expect(page.find('[data-delete-account]')).toHaveLength(1)
  })

  it('goes to auth.cookrew.dev for the deletion, and comes back with the name kept and the button to press', async () => {
    const page = openMe({ route: (m, u) => (m === 'DELETE' && u === '/v2/me' ? STEP_UP : undefined) })
    page.find('#me-delete-name')[0].value = 'anvztor'
    page.press('[data-delete-account]')
    await page.settle()
    expect(page.trips).toEqual([{ intent: 'step-up', extra: { act: 'delete-account' } }])
    expect(saved(page)).toMatchObject({ act: 'delete-account', resume: { kind: 'delete', name: 'anvztor' } })
    expect(JSON.stringify(saved(page))).not.toMatch(/current|password/)

    const back = openMe({
      search: '?stepped=delete-account',
      hash: `#stepup=${PROOF}`,
      stored: Object.fromEntries(page.storage),
      route: (m, u) => (m === 'DELETE' && u === '/v2/me' ? { status: 204 } : undefined)
    })
    await back.land()
    // The one act that cannot be taken back waits for its button.
    expect(sent(back, 'DELETE', '/v2/me')).toEqual([])
    expect(back.find('#me-delete-name')[0].value).toBe('anvztor')
    expect(back.find('#me-delete')[0].open).toBe(true)
    expect(back.doc.getElementById('me-delete-note')?.textContent).toMatch(/Confirmed/)
    back.press('[data-delete-account]')
    await back.settle()
    expect(sent(back, 'DELETE', '/v2/me').map((c) => c.body)).toEqual([{ confirm: 'anvztor', stepUp: PROOF }])
  })
})

describe('the other acts, for an account with no password', () => {
  it('recovery codes: the trip, then the codes on the way back', async () => {
    const page = openMe({ route: (m, u) => (u === '/v2/me/recovery-codes' ? STEP_UP : undefined) })
    page.press('[data-recovery]')
    await page.settle()
    expect(page.trips).toEqual([{ intent: 'step-up', extra: { act: 'add-factor' } }])
    const back = openMe({
      search: '?stepped=add-factor',
      hash: `#stepup=${PROOF}`,
      stored: Object.fromEntries(page.storage),
      route: (m, u) => (u === '/v2/me/recovery-codes' ? { status: 201, body: { codes: ['AAAA-BBBB', 'CCCC-DDDD'] } } : undefined)
    })
    await back.land()
    expect(sent(back, 'POST', '/v2/me/recovery-codes').map((c) => c.body)).toEqual([{ stepUp: PROOF }])
    expect(back.doc.getElementById('me-codes')?.textContent).toContain('AAAA-BBBB')
  })

  it('an authenticator: the trip, then the QR on the way back', async () => {
    const page = openMe({ route: (m, u) => (u === '/v2/me/totp/enrol' ? { status: 403, body: { error: 'provider_required', message: 'Confirm with your provider first.' } } : undefined) })
    page.press('[data-add-totp]')
    await page.settle()
    expect(page.trips).toEqual([{ intent: 'step-up', extra: { act: 'add-factor' } }])
    expect(page.prompts).toEqual([])
    const back = openMe({
      search: '?stepped=add-factor',
      hash: `#stepup=${PROOF}`,
      stored: Object.fromEntries(page.storage),
      route: (m, u) => (u === '/v2/me/totp/enrol' ? { status: 201, body: { secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/x', qr: [] } } : undefined)
    })
    await back.land()
    expect(sent(back, 'POST', '/v2/me/totp/enrol').map((c) => c.body)).toEqual([{ stepUp: PROOF }])
    expect(back.find('.totp-secret')[0]?.textContent).toBe('JBSWY3DPEHPK3PXP')
  })

  it('revoking another device: confirmed once, then finished on the way back', async () => {
    const id = '66666666-2222-4333-8444-555555555555'
    const page = openMe({ route: (m, u) => (m === 'DELETE' && u === `/v2/me/devices/${id}` ? STEP_UP : undefined) })
    const row = page.find('[data-revoke]').find((b) => b.dataset.revoke === id)
    expect(row).toBeDefined()
    row?.dispatch('click')
    await page.settle()
    expect(saved(page)).toMatchObject({ act: 'revoke-device', resume: { kind: 'revoke', id, own: false } })
    const back = openMe({
      search: '?stepped=revoke-device',
      hash: `#stepup=${PROOF}`,
      stored: Object.fromEntries(page.storage),
      route: (m, u) => (m === 'DELETE' && u === `/v2/me/devices/${id}` ? { status: 204 } : undefined)
    })
    await back.land()
    expect(sent(back, 'DELETE', `/v2/me/devices/${id}`).map((c) => c.body)).toEqual([{ stepUp: PROOF }])
  })

  it('adding a machine: the trip, then the join code on the way back', async () => {
    const page = openMe({ route: (m, u) => (u === '/v2/me/join-codes' ? STEP_UP : undefined) })
    // The account page offers one ADD button, for a machine: the phone's went with the registry's /me.
    expect(page.find('[data-add-device]').map((b) => b.dataset.addDevice)).toEqual(['desktop'])
    page.find('[data-add-device]')[0].dispatch('click')
    await page.settle()
    expect(page.prompts).toEqual([])
    expect(saved(page)).toMatchObject({ act: 'mint-join-code', resume: { kind: 'join', device: 'desktop' } })
    const back = openMe({
      search: '?stepped=mint-join-code',
      hash: `#stepup=${PROOF}`,
      stored: Object.fromEntries(page.storage),
      route: (m, u) => (u === '/v2/me/join-codes' ? { status: 201, body: { code: 'ABCD-EFGH', qr: [], expiresAt: Date.now() + 600_000 } } : undefined)
    })
    await back.land()
    expect(sent(back, 'POST', '/v2/me/join-codes').map((c) => c.body)).toEqual([{ stepUp: PROOF }])
    expect(back.find('.acct-join-code')[0]?.textContent).toBe('ABCD-EFGH')
  })
})

describe('an account with a password keeps typing it here', () => {
  it('recovery codes ask for the password once, and nobody leaves the page', async () => {
    const page = openMe({
      passwordless: false,
      password: 'correct horse battery staple',
      route: (m, u, b) =>
        u === '/v2/me/recovery-codes'
          ? b.current === 'correct horse battery staple'
            ? { status: 201, body: { codes: ['AAAA-BBBB'] } }
            : { status: 401, body: { error: 'step_up', message: 'Prove it is you before adding a way back into the account.' } }
          : undefined
    })
    page.press('[data-recovery]')
    await page.settle()
    expect(page.prompts).toHaveLength(1)
    expect(page.trips).toEqual([])
    expect(page.doc.getElementById('me-codes')?.textContent).toContain('AAAA-BBBB')
  })

  it('the delete form keeps its password field, and the typed password is the proof', async () => {
    const page = openMe({ passwordless: false, route: (m, u, b) => (m === 'DELETE' && u === '/v2/me' && b.current === 'pw pw pw pw pw' ? { status: 204 } : STEP_UP) })
    expect(page.find('#me-delete-password')).toHaveLength(1)
    page.find('#me-delete-name')[0].value = 'anvztor'
    page.find('#me-delete-password')[0].value = 'pw pw pw pw pw'
    page.press('[data-delete-account]')
    await page.settle()
    expect(sent(page, 'DELETE', '/v2/me').map((c) => c.body)).toEqual([{ confirm: 'anvztor', current: 'pw pw pw pw pw' }])
    expect(page.trips).toEqual([])
  })

  it('adding a machine and taking the authenticator off ask for the password here', async () => {
    const page = openMe({
      passwordless: false,
      password: 'pw pw pw pw pw',
      route: (m, u, b) =>
        u === '/v2/me/join-codes' || u === '/v2/me/totp'
          ? b.current === 'pw pw pw pw pw'
            ? u === '/v2/me/totp'
              ? { status: 204 }
              : { status: 201, body: { code: 'ABCD-EFGH', qr: [], expiresAt: Date.now() + 600_000 } }
            : { status: 403, body: { error: 'password_required', message: 'Type your password.' } }
          : undefined
    })
    page.find('[data-add-device]')[0].dispatch('click')
    await page.settle()
    expect(page.find('.acct-join-code')[0]?.textContent).toBe('ABCD-EFGH')
    expect(page.prompts).toHaveLength(1)
    expect(page.trips).toEqual([])
  })
})
