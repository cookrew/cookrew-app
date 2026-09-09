import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { mePage } from '../registry/src/site-account'
import { qrRows } from '../registry/src/v2-qr'
import { base32Decode, mintTotpSecret, otpauthUrl, totpAt } from '../registry/src/v2-totp'
import type { V2Account } from '../registry/src/v2-accounts'
import { El, MiniDocument, parseHtml } from './support/mini-dom'

/**
 * ADD AN AUTHENTICATOR ON /me — scan, then verify (owner's note, 2026-09-06).
 *
 * It was two `prompt()` boxes with the secret as text: unscannable, and asking
 * a person to retype 32 characters out of a dialog they cannot copy from. The
 * desktop sheet shows a QR and then verifies, and /me must do what the desktop
 * does.
 *
 * The page's own markup out of site-account.ts, the real factors.js, and a DOM
 * where `replaceChildren` really detaches — so what is asserted here is what a
 * browser would put on the screen, including the QR's module count, which is
 * the one property a picture of a QR either has or does not.
 */

const read = (name: string): string =>
  readFileSync(path.join(__dirname, '..', 'registry', 'assets', name), 'utf8')
const SCRIPTS = ['device-id.js', 'site.js', 'factors.js'].map(read)

const SECRET = mintTotpSecret()
const OTPAUTH = otpauthUrl('mira', SECRET)
const QR = qrRows(OTPAUTH)
/** RFC 6238, computed here rather than trusted — the test is the phone. */
const codeNow = (): string => totpAt(base32Decode(SECRET) as Buffer, Date.now())

const account = (): V2Account => ({
  username: 'mira',
  password: { salt: 'x', hash: 'y' },
  displayName: 'Mira',
  avatar: null,
  claimedAt: Date.parse('2026-09-01T00:00:00Z'),
  devices: [
    {
      id: '11111111-2222-4333-8444-555555555555',
      kind: 'browser',
      name: 'Chrome on macOS',
      jwk: { kty: 'OKP', crv: 'Ed25519', x: 'zz' },
      addedAt: 0,
      lastSeenAt: 0
    }
  ],
  desktops: [],
  sessions: [],
  recovery: [],
  revoked: []
})

type Answer = { status: number; body?: unknown }

interface Page {
  doc: MiniDocument
  calls: string[]
  errors: unknown[]
  settle: (turns?: number) => Promise<void>
  find: (selector: string) => El[]
  words: () => string
  press: (selector: string) => void
}

/** /me as the registry renders it, with both scripts running over it. */
function openMe(route: (method: string, url: string, body: Record<string, unknown>) => Answer, totp = false): Page {
  const doc = new MiniDocument()
  const rendered = mePage({
    account: account(),
    currentDeviceId: '11111111-2222-4333-8444-555555555555',
    factors: { passkeys: [], totp }
  })
  const body = /<body>([\s\S]*)<\/body>/.exec(rendered.body)?.[1] ?? ''
  for (const node of parseHtml(body, doc)) doc.body.append(node)

  const calls: string[] = []
  const errors: unknown[] = []
  const guard =
    <T extends unknown[]>(fn: (...args: T) => void) =>
    (...args: T): void => {
      try {
        fn(...args)
      } catch (error) {
        errors.push(error)
      }
    }
  const sandbox: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(guard(fn), ms),
    clearTimeout,
    // The approvals poll would otherwise run for the length of the suite.
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
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    indexedDB: { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) },
    confirm: () => true,
    // If either of these is ever reached again, the flow has gone back to
    // asking a person to retype a secret out of a modal.
    prompt: () => {
      errors.push(new Error('prompt() — the panel is meant to be in the page'))
      return null
    },
    location: {
      hash: '',
      origin: 'https://cookrew.dev',
      hostname: 'cookrew.dev',
      protocol: 'https:',
      search: '',
      assign: (url: string) => calls.push(`assign ${url}`),
      reload: () => calls.push('reload')
    },
    addEventListener: () => undefined,
    document: doc,
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      const answer = route(method, url, init?.body ? JSON.parse(init.body) : {})
      return {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => {
          if (answer.body === undefined) throw new Error('no body')
          return answer.body
        }
      }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  for (const script of SCRIPTS) vm.runInNewContext(script, sandbox)

  return {
    doc,
    calls,
    errors,
    settle: async (turns = 10) => {
      for (let at = 0; at < turns; at += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    },
    find: (selector: string) => doc.querySelectorAll(selector),
    words: () => doc.body.textContent,
    press: (selector: string) => {
      const node = doc.querySelectorAll(selector)[0]
      expect(node, selector).toBeDefined()
      node.dispatch('click')
    }
  }
}

const enrolRoutes = (confirm: (code: unknown) => Answer, password?: (body: Record<string, unknown>) => Answer) => (method: string, url: string, body: Record<string, unknown>): Answer => {
  if (url === '/v2/me/password' && method === 'POST') {
    return password ? password(body) : { status: 401, body: { error: 'bad_credentials', message: WRONG_CURRENT } }
  }
  if (url === '/v2/me/totp/enrol' && method === 'POST') {
    return { status: 201, body: { secret: SECRET, otpauth: OTPAUTH, qr: QR } }
  }
  if (url === '/v2/me/totp/confirm' && method === 'POST') return confirm(body.code)
  if (url === '/v2/me/approvals') return { status: 200, body: [] }
  return { status: 401, body: { error: 'unauthenticated', message: 'Sign in to see this.' } }
}

const BAD_CODE = 'That is not the code showing right now. Wait for the next one and type it as it appears.'
const WRONG_CURRENT = 'That name and password do not go together. Try again, or use a recovery code.'
const PASSWORD = 'correct horse battery staple'
const accepted = (code: unknown): Answer =>
  code === codeNow() ? { status: 204 } : { status: 401, body: { error: 'bad_code', message: BAD_CODE } }

describe('the authenticator panel on /me', () => {
  it('shows a QR to scan, the secret to type, and the URL for an app that takes one', async () => {
    const page = openMe(enrolRoutes(accepted))
    await page.settle()
    expect(page.find('#me-totp')[0].hidden).toBe(true)

    page.press('[data-add-totp]')
    await page.settle()

    const svg = page.find('[data-modules]')
    expect(svg).toHaveLength(1)
    // The module count is the QR: a picture with the wrong one is a picture of
    // something else. Four modules of quiet zone on every side, so the
    // viewBox is eight wider than the symbol.
    expect(svg[0].dataset.modules).toBe(String(QR.length))
    expect(svg[0].getAttribute('viewBox')).toBe(`0 0 ${QR.length + 8} ${QR.length + 8}`)
    expect(Number(svg[0].getAttribute('width'))).toBeGreaterThanOrEqual(200)
    expect(svg[0].querySelector('path')?.getAttribute('d')?.length ?? 0).toBeGreaterThan(100)

    expect(page.find('.totp-secret')[0].textContent).toBe(SECRET)
    expect(page.words()).toContain('or type this secret')
    expect(page.find('.totp-link')[0].getAttribute('href')).toBe(OTPAUTH)
    expect(page.find('.acct-code')).toHaveLength(1)
    expect(page.errors).toEqual([])
  })

  it('makes the row active only after a code the registry accepts', async () => {
    const page = openMe(enrolRoutes(accepted))
    await page.settle()
    page.press('[data-add-totp]')
    await page.settle()
    // Still not a factor: the account has an inactive secret and the row has
    // not moved.
    expect(page.find('[data-drop-totp]')).toHaveLength(0)

    page.find('.acct-code')[0].value = codeNow()
    page.press('.totp-panel button')
    await page.settle()

    expect(page.calls).toContain('POST /v2/me/totp/confirm')
    expect(page.find('[data-drop-totp]')).toHaveLength(1)
    expect(page.find('[data-add-totp]')).toHaveLength(0)
    expect(page.doc.getElementById('me-totp-note')?.textContent).toContain('Six digits, every thirty seconds')
    // The panel is done with, and nobody was sent through a page reload with
    // six digits half typed.
    expect(page.find('#me-totp')[0].hidden).toBe(true)
    expect(page.calls).not.toContain('reload')
    expect(page.errors).toEqual([])
  })

  it('shows the registry’s sentence under the field for a wrong code, and stays put', async () => {
    const page = openMe(enrolRoutes(accepted))
    await page.settle()
    page.press('[data-add-totp]')
    await page.settle()

    page.find('.acct-code')[0].value = '000000'
    page.press('.totp-panel button')
    await page.settle()

    expect(page.find('.totp-said')[0].textContent).toBe(BAD_CODE)
    // The QR and the field are still there to try again with.
    expect(page.find('[data-modules]')).toHaveLength(1)
    expect(page.find('.acct-code')).toHaveLength(1)
    expect(page.find('[data-drop-totp]')).toHaveLength(0)
    expect(page.errors).toEqual([])
  })

  it('discards everything on cancel, and enrols nothing', async () => {
    const page = openMe(enrolRoutes(accepted))
    await page.settle()
    page.press('[data-add-totp]')
    await page.settle()

    const cancel = page.find('.totp-panel button').find((b) => b.textContent === 'Cancel')
    expect(cancel).toBeDefined()
    cancel?.dispatch('click')
    await page.settle()

    expect(page.find('#me-totp')[0].hidden).toBe(true)
    expect(page.find('[data-modules]')).toHaveLength(0)
    expect(page.find('.totp-secret')).toHaveLength(0)
    // Nothing was confirmed, so the row still offers ADD.
    expect(page.find('[data-add-totp]')).toHaveLength(1)
    expect(page.calls).not.toContain('POST /v2/me/totp/confirm')
    expect(page.errors).toEqual([])
  })

  it('offers REMOVE and no panel to an account that already has one', async () => {
    const page = openMe(enrolRoutes(accepted), true)
    await page.settle()
    expect(page.find('[data-drop-totp]')).toHaveLength(1)
    expect(page.find('[data-add-totp]')).toHaveLength(0)
    expect(page.find('[data-modules]')).toHaveLength(0)
  })
})

/**
 * CHANGE YOUR PASSWORD, in the page (owner's note, 2026-09-06).
 *
 * It never asked for the current password and never checked the new one: two
 * `prompt()` boxes and a toast. This is the one control on /me that ends every
 * OTHER sitting on the account, so it has to be the hardest to press by
 * accident and the clearest about what it did.
 */
describe('the password panel on /me', () => {
  const fields = (page: Page): El[] => page.find('#me-password input')
  const primary = (page: Page): El =>
    page.find('#me-password button').find((b) => b.textContent === 'Change password') as El
  const type = (field: El, value: string): void => {
    field.value = value
    field.dispatch('input')
  }

  const openPanel = async (route: Parameters<typeof openMe>[0]): Promise<Page> => {
    const page = openMe(route)
    await page.settle()
    expect(page.find('#me-password')[0].hidden).toBe(true)
    page.press('[data-password]')
    await page.settle()
    return page
  }

  it('asks for the current password, the new one, and it again', async () => {
    const page = await openPanel(enrolRoutes(accepted))
    expect(fields(page)).toHaveLength(3)
    expect(page.words()).toContain('Current password')
    expect(page.words()).toContain('New password')
    expect(page.words()).toContain('Repeat new password')
    expect(page.find('#me-password')[0].hidden).toBe(false)
    // Nothing was asked of the registry by opening a panel.
    expect(page.calls).not.toContain('POST /v2/me/password')
    expect(page.errors).toEqual([])
  })

  it('keeps the primary shut until all three are right, and says why', async () => {
    const page = await openPanel(enrolRoutes(accepted))
    const [current, next, again] = fields(page)
    expect(primary(page).disabled).toBe(true)

    type(current, PASSWORD)
    type(next, 'short')
    expect(primary(page).disabled).toBe(true)
    expect(page.find('#me-password .chip')[1].textContent).toBe('weak')
    expect(page.words()).toContain('Too easy to guess')

    type(next, 'a much longer new password')
    type(again, 'a much longer new passwor')
    expect(primary(page).disabled).toBe(true)
    expect(page.words()).toContain('These two do not match yet.')

    type(again, 'a much longer new password')
    expect(primary(page).disabled).toBe(false)
    expect(page.words()).not.toContain('These two do not match yet.')
    // The strength hint is the register sheet's own reading.
    expect(page.find('#me-password .chip')[1].textContent).toBe('strong')
  })

  it('shows the registry’s sentence when the current password is wrong', async () => {
    const page = await openPanel(enrolRoutes(accepted))
    const [current, next, again] = fields(page)
    type(current, 'not it at all')
    type(next, 'a much longer new password')
    type(again, 'a much longer new password')
    primary(page).dispatch('click')
    await page.settle()

    expect(page.calls).toContain('POST /v2/me/password')
    expect(page.find('.totp-said')[0].textContent).toBe(WRONG_CURRENT)
    // Still open, with what was typed still there to correct.
    expect(page.find('#me-password')[0].hidden).toBe(false)
    expect(fields(page)).toHaveLength(3)
    expect(page.errors).toEqual([])
  })

  it('says what a change did, and keeps this session', async () => {
    const page = await openPanel(
      enrolRoutes(accepted, (body) => (body.current === PASSWORD ? { status: 204 } : { status: 401 }))
    )
    const [current, next, again] = fields(page)
    type(current, PASSWORD)
    type(next, 'a much longer new password')
    type(again, 'a much longer new password')
    primary(page).dispatch('click')
    await page.settle()

    expect(page.doc.getElementById('me-password-note')?.textContent).toBe(
      'Password changed. Every other device was signed out.'
    )
    expect(page.find('#me-password')[0].hidden).toBe(true)
    // The registry keeps the caller's jti, so nothing signs this browser out
    // and nothing reloads under it.
    expect(page.calls).not.toContain('reload')
    expect(page.calls).not.toContain('assign /')
    expect(page.errors).toEqual([])
  })

  it('discards everything on cancel', async () => {
    const page = await openPanel(enrolRoutes(accepted))
    const cancel = page.find('#me-password button').find((b) => b.textContent === 'Cancel')
    cancel?.dispatch('click')
    await page.settle()
    expect(page.find('#me-password')[0].hidden).toBe(true)
    expect(fields(page)).toHaveLength(0)
    expect(page.calls).not.toContain('POST /v2/me/password')
  })
})
