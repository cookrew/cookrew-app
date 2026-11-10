import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { mePage } from '../registry/src/site-account'
import type { V2Account } from '../registry/src/v2-accounts'
import { MiniDocument, parseHtml } from './support/mini-dom'

/**
 * ADD A PASSKEY ON /me GOES TO AUTH.COOKREW.DEV.
 *
 * The owner's account has no password, and /me's button POSTed the options
 * route with an empty body: the registry asked for a provider step-up the page
 * could not make, and the page toasted the refusal. Now the button opens a
 * `passkey` request on the auth page (site.js, with this browser's session and
 * device key), and only a registry without that page leaves the ceremony here.
 */

const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'registry', 'assets', name), 'utf8')
const SCRIPTS = ['device-id.js', 'site.js', 'factors.js'].map(read)

const account = (): V2Account => ({
  username: 'anvztor',
  password: { salt: 'x', hash: 'y' },
  passwordless: true,
  displayName: '',
  avatar: null,
  claimedAt: Date.parse('2026-11-09T00:00:00Z'),
  devices: [
    { id: '11111111-2222-4333-8444-555555555555', kind: 'browser', name: 'Chrome on macOS', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'zz' }, addedAt: 0, lastSeenAt: 0 }
  ],
  desktops: [],
  sessions: [],
  recovery: [],
  revoked: []
}) as V2Account

type Answer = { status: number; body?: unknown }

/** The page lives on the auth host only (0.6.0): it is always drawn standalone. */
const STANDALONE = { site: 'https://cookrew.dev', console: 'https://console.cookrew.dev', home: '/account' }
function openMe(options: { through: ((intent: string) => Promise<boolean>) | null; search?: string; route?: (method: string, url: string) => Answer }) {
  const doc = new MiniDocument()
  const rendered = mePage({ account: account(), currentDeviceId: '11111111-2222-4333-8444-555555555555', factors: { passkeys: [], totp: false } }, STANDALONE)
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(rendered.body)?.[1] ?? ''
  for (const node of parseHtml(body, doc)) doc.body.append(node)
  if (doc.getElementById('toast') === null) for (const node of parseHtml('<div id="toast" hidden></div>', doc)) doc.body.append(node)
  const calls: string[] = []
  const location = {
    hash: '#security',
    pathname: '/me',
    origin: 'https://cookrew.dev',
    hostname: 'cookrew.dev',
    protocol: 'https:',
    search: options.search ?? '',
    assign: (url: string) => calls.push(`assign ${url}`),
    reload: () => calls.push('reload')
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
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140', credentials: { create: async () => null } },
    PublicKeyCredential: function PublicKeyCredential() {},
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    indexedDB: { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) },
    confirm: () => true,
    prompt: () => 'This browser',
    history: { replaceState: (_s: unknown, _t: string, url: string) => calls.push(`replace ${url}`) },
    location,
    addEventListener: () => undefined,
    document: doc,
    fetch: async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      const answer = options.route?.(method, url) ?? { status: 200, body: [] }
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body ?? {} }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.runInNewContext(SCRIPTS[0], sandbox)
  vm.runInNewContext(SCRIPTS[1], sandbox)
  const account_ = sandbox.cookrewAccount as Record<string, unknown>
  if (options.through === null) delete account_.throughAuthSite
  else account_.throughAuthSite = options.through
  vm.runInNewContext(SCRIPTS[2], sandbox)
  const settle = async (): Promise<void> => {
    for (let at = 0; at < 10; at += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const press = (selector: string): void => {
    doc.querySelectorAll(selector)[0].dispatch('click')
  }
  return { doc, calls, settle, press, toast: () => doc.getElementById('toast') }
}

describe('Add a passkey on /me', () => {
  it('opens a passkey request on the auth page and never asks the old route', async () => {
    const asked: string[] = []
    const page = openMe({ through: async (intent) => (asked.push(intent), true) })
    page.press('[data-add-passkey]')
    await page.settle()
    expect(asked).toEqual(['passkey'])
    expect(page.calls).not.toContain('POST /v2/me/passkeys/options')
  })

  it('a second press while the first is opening starts nothing more', async () => {
    const asked: string[] = []
    const page = openMe({ through: (intent) => (asked.push(intent), new Promise<boolean>(() => undefined)) })
    page.press('[data-add-passkey]')
    page.press('[data-add-passkey]')
    await page.settle()
    expect(asked).toEqual(['passkey'])
  })

  it('falls back to the ceremony on the page only when the registry has no auth page', async () => {
    const page = openMe({
      through: async () => false,
      route: (method, url) =>
        method === 'POST' && url === '/v2/me/passkeys/options'
          ? { status: 403, body: { error: 'provider_required', message: 'This account has no password. Sign in with your provider again to do this.' } }
          : { status: 200, body: [] }
    })
    page.press('[data-add-passkey]')
    await page.settle()
    expect(page.calls).toContain('POST /v2/me/passkeys/options')
    // The refusal is said, not swallowed.
    expect(page.toast()?.textContent).toContain('This account has no password')
  })

  it('says the passkey was added when the auth page brings the browser back, and tidies the address', async () => {
    const page = openMe({ through: async () => true, search: '?passkey=added' })
    await page.settle()
    expect(page.toast()?.textContent).toContain('Passkey added')
    expect(page.toast()?.hidden).toBe(false)
    expect(page.calls).toContain('replace /me#security')
  })

  it('has a #security anchor for the desktop’s link to land on', () => {
    const page = openMe({ through: async () => true })
    expect(page.doc.getElementById('security')).not.toBeNull()
  })
})
