import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { ACCOUNT_SHEET } from '../registry/src/site-shell'
import { El, MiniDocument, parseHtml } from './support/mini-dom'

/**
 * THE LADDER IN THE SHEET — the real markup, the real two scripts.
 *
 * Real-UI QA found a wrong code showing NO refusal at all: the ladder replaces
 * the form's children, which detaches `#acct-message`, so every `say()` after
 * that wrote into a node the document no longer held — and site.js's `finally`
 * then threw on a submit button that had been detached with it. Neither is
 * visible to a test that stubs `getElementById` with a Map, because a Map
 * hands back a node for any id it is ever asked for.
 *
 * So: the sheet's own markup out of site-shell.ts, both browser files loaded
 * and run, and a DOM where replacing children really does detach them.
 */

const read = (name: string): string =>
  readFileSync(path.join(__dirname, '..', 'registry', 'assets', name), 'utf8')
// The page loads them in this order, and site.js reaches for what
// device-id.js puts on globalThis while minting this browser's device.
const SCRIPTS = ['device-id.js', 'site.js', 'factors.js'].map(read)

const STEP = {
  error: 'second_factor',
  message: 'One more step. Prove it is you.',
  next: ['totp', 'approve'],
  pending: '11111111-2222-4333-8444-555555555555',
  expiresAt: 0
}
const BAD_CODE = 'That is not the code showing right now. Wait for the next one and type it as it appears.'
const TOO_MANY = 'Too many tries on this sign-in. Start again.'
const EXPIRED = 'That sign-in took too long, so it was dropped. Start again with your password.'

interface Sheet {
  doc: MiniDocument
  dialog: El
  form: El
  /** Anything a timer threw — a browser would swallow these; a test must not. */
  errors: unknown[]
  assigned: string[]
  settle: (turns?: number) => Promise<void>
  /** Every visible word inside the sheet right now. */
  words: () => string
  find: (selector: string) => El[]
}

/** An IndexedDB that actually answers, or `deviceIdentity()` never resolves. */
function fakeIndexedDb(): unknown {
  const held = new Map<string, unknown>()
  const request = (result?: unknown): Record<string, unknown> => {
    const req: Record<string, unknown> = { result, onsuccess: null, onerror: null }
    setTimeout(() => (req.onsuccess as (() => void) | null)?.(), 0)
    return req
  }
  const store = {
    get: (key: string) => request(held.get(key)),
    put: (value: unknown, key: string) => {
      held.set(key, value)
      return request()
    },
    delete: (key: string) => {
      held.delete(key)
      return request()
    }
  }
  return {
    open: () => {
      const db = {
        createObjectStore: () => undefined,
        transaction: () => {
          const tx: Record<string, unknown> = { objectStore: () => store, oncomplete: null }
          setTimeout(() => (tx.oncomplete as (() => void) | null)?.(), 1)
          return tx
        },
        close: () => undefined
      }
      const req: Record<string, unknown> = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }
      setTimeout(() => {
        ;(req.onupgradeneeded as (() => void) | null)?.()
        ;(req.onsuccess as (() => void) | null)?.()
      }, 0)
      return req
    }
  }
}

type Answer = { status: number; body?: unknown }

function open(
  route: (method: string, url: string, body: Record<string, unknown>) => Answer,
  options: { passkeys?: boolean } = {}
): Sheet {
  const doc = new MiniDocument()
  for (const node of parseHtml(ACCOUNT_SHEET, doc)) doc.body.append(node)
  const toast = doc.createElement('div')
  toast.id = 'toast'
  doc.body.append(toast)

  const errors: unknown[] = []
  const assigned: string[] = []
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
    // A timer that swallows its exception is how the debounced name check
    // disappeared in the browser; here every throw is kept.
    setTimeout: (fn: () => void, ms?: number) => setTimeout(guard(fn), ms),
    clearTimeout,
    setInterval: (fn: () => void, ms?: number) => setInterval(guard(fn), ms),
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
    indexedDB: fakeIndexedDb(),
    // WebAuthn is a capability, not a setting: the W1 button appears only
    // where `PublicKeyCredential` is a function.
    ...(options.passkeys === true ? { PublicKeyCredential: function PublicKeyCredential() {} } : {}),
    confirm: () => true,
    prompt: () => '123456',
    location: {
      hash: '#account',
      origin: 'https://cookrew.dev',
      hostname: 'cookrew.dev',
      protocol: 'https:',
      search: '',
      assign: (url: string) => assigned.push(url),
      reload: () => assigned.push('reload')
    },
    addEventListener: () => undefined,
    document: doc,
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const answer = route(init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body) : {})
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

  const dialog = doc.getElementById('account-sheet') as El
  const form = doc.getElementById('account-form') as El
  return {
    doc,
    dialog,
    form,
    errors,
    assigned,
    settle: async (turns = 12) => {
      for (let at = 0; at < turns; at += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    },
    words: () => dialog.textContent,
    find: (selector: string) => dialog.querySelectorAll(selector)
  }
}

/** Sign in with a password that is right, and land on the ladder. */
async function toLadder(sheet: Sheet): Promise<void> {
  ;(sheet.doc.getElementById('acct-username') as El).value = 'mira'
  ;(sheet.doc.getElementById('acct-password') as El).value = 'correct horse battery staple'
  ;(sheet.doc.getElementById('acct-submit') as El).dispatch('click')
  await sheet.settle()
}

/** Open the CODE rung — or stay on it, which is where a refusal leaves you. */
async function typeCode(sheet: Sheet, code: string): Promise<void> {
  if (sheet.find('.acct-code').length === 0) {
    const rung = sheet.find('.acct-rung').find((row) => row.textContent.includes('Authenticator app'))
    expect(rung, 'the ladder offers the authenticator').toBeDefined()
    rung?.querySelector('button')?.dispatch('click')
    await sheet.settle()
  }
  const field = sheet.find('.acct-code')[0]
  expect(field, 'the code field').toBeDefined()
  field.value = code
  const go = sheet
    .find('button')
    .find((b) => b.textContent === 'Continue')
  go?.dispatch('click')
  await sheet.settle()
}

const ladderRoutes = (totp: (n: number) => Answer) => {
  let tries = 0
  return (method: string, url: string): Answer => {
    if (url.startsWith('/v2/me')) return { status: 401, body: { error: 'unauthenticated' } }
    if (method === 'HEAD') return { status: 404 }
    if (url === '/v2/sessions' && method === 'POST') {
      return { status: 401, body: { ...STEP, expiresAt: Date.now() + 600_000 } }
    }
    if (url === `/v2/sessions/${STEP.pending}/totp`) return totp(++tries)
    if (url === `/v2/sessions/${STEP.pending}`) return { status: 202, body: { status: 'waiting' } }
    return { status: 404, body: { error: 'not_found', message: 'There is nothing at that address.' } }
  }
}

describe('the sheet becomes the ladder', () => {
  it('shows the ways in, and keeps a place to say things', async () => {
    const sheet = open(ladderRoutes(() => ({ status: 401, body: { error: 'bad_code', message: BAD_CODE } })))
    await sheet.settle()
    expect(sheet.dialog.open).toBe(true)
    await toLadder(sheet)

    expect(sheet.words()).toContain('One more step')
    expect(sheet.find('.acct-rung')).toHaveLength(2)
    expect(sheet.words()).toContain('Authenticator app')
    expect(sheet.words()).toContain('On a device you already use')
    // The form's own children are gone — which is exactly why anything that
    // still reaches for them by id has to be written for their absence.
    expect(sheet.doc.getElementById('acct-submit')).toBeNull()
    expect(sheet.errors).toEqual([])
  })

  it('says a wrong code IS wrong, where the person is looking', async () => {
    const sheet = open(ladderRoutes(() => ({ status: 401, body: { error: 'bad_code', message: BAD_CODE } })))
    await sheet.settle()
    await toLadder(sheet)
    await typeCode(sheet, '000000')

    expect(sheet.words()).toContain('not the code showing right now')
    // Still on the code screen, with what was typed still there to correct.
    expect(sheet.find('.acct-code')).toHaveLength(1)
    expect(sheet.errors).toEqual([])
    expect(sheet.assigned).toEqual([])
  })

  it('distinguishes five wrong codes from a sign-in that went cold', async () => {
    const sheet = open(
      ladderRoutes((n) =>
        n <= 5
          ? { status: 401, body: { error: 'bad_code', message: BAD_CODE } }
          : { status: 410, body: { error: 'too_many_attempts', message: TOO_MANY } }
      )
    )
    await sheet.settle()
    await toLadder(sheet)
    for (let at = 0; at < 5; at += 1) await typeCode(sheet, '000000')
    expect(sheet.words()).toContain('not the code showing')

    await typeCode(sheet, '000000')
    expect(sheet.words()).toContain('Too many tries on this sign-in')
    expect(sheet.words()).not.toContain('took too long')
    expect(sheet.errors).toEqual([])
  })

  it('says a sign-in went cold when that is what happened', async () => {
    const sheet = open(ladderRoutes(() => ({ status: 410, body: { error: 'expired', message: EXPIRED } })))
    await sheet.settle()
    await toLadder(sheet)
    await typeCode(sheet, '000000')
    expect(sheet.words()).toContain('took too long')
    expect(sheet.words()).not.toContain('Too many tries')
  })

  it('survives the name check that fires after the form has gone', async () => {
    const sheet = open(ladderRoutes(() => ({ status: 401, body: { error: 'bad_code', message: BAD_CODE } })))
    await sheet.settle()
    const username = sheet.doc.getElementById('acct-username') as El
    await toLadder(sheet)
    // The debounce was armed by typing and lands 280 ms later, by which time
    // the field it reads is detached. A browser reports that as a red console
    // line nobody sees; here it is a failure.
    username.dispatch('input')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sheet.errors).toEqual([])
  })

  it('gives the sheet back when it is closed, so the next open is a sign-in', async () => {
    const sheet = open(ladderRoutes(() => ({ status: 401, body: { error: 'bad_code', message: BAD_CODE } })))
    await sheet.settle()
    await toLadder(sheet)
    expect(sheet.doc.getElementById('acct-username')).toBeNull()

    sheet.dialog.close()
    await sheet.settle(2)
    expect(sheet.doc.getElementById('acct-username')).not.toBeNull()
    expect(sheet.doc.getElementById('acct-submit')).not.toBeNull()
    expect(sheet.find('.acct-rung')).toHaveLength(0)
  })
})

describe('the W1 passkey button', () => {
  const nothing = () => ({ status: 404 }) as Answer

  it('is offered where the browser has passkeys', async () => {
    const sheet = open(nothing, { passkeys: true })
    await sheet.settle()
    const button = sheet.find('[data-passkey-signin]')
    expect(button).toHaveLength(1)
    expect(button[0].textContent).toBe('Sign in with a passkey')
    // Above the username, with the "or" between: W1's first button.
    expect(sheet.words().indexOf('Sign in with a passkey')).toBeLessThan(sheet.words().indexOf('Username'))
  })

  it('is not offered where there are none, rather than failing when pressed', async () => {
    const sheet = open(nothing)
    await sheet.settle()
    expect(sheet.find('[data-passkey-signin]')).toHaveLength(0)
    expect(sheet.errors).toEqual([])
  })
})
