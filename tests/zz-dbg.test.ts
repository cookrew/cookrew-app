import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { ACCOUNT_SHEET } from '../registry/src/site-shell'
import { MiniDocument, parseHtml } from './support/mini-dom'

describe('debug', () => {
  it('submits', async () => {
    const doc = new MiniDocument()
    for (const node of parseHtml(ACCOUNT_SHEET, doc)) doc.body.append(node)
    const t = doc.createElement('div'); t.id = 'toast'; doc.body.append(t)
    const errors: unknown[] = []
    const calls: string[] = []
    process.on('unhandledRejection', (e) => errors.push(e))
    const sandbox: Record<string, unknown> = {
      setTimeout, clearTimeout, setInterval, clearInterval,
      btoa: globalThis.btoa, atob: globalThis.atob, crypto: globalThis.crypto,
      TextEncoder, TextDecoder, URL, URLSearchParams, console,
      PublicKeyCredential: function () {},
      navigator: { userAgent: 'Chrome/140 (Macintosh)' },
      sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      indexedDB: (() => {
        const held = new Map<string, unknown>()
        const request = (result?: unknown) => { const r: any = { result, onsuccess: null, onerror: null }; setTimeout(() => r.onsuccess?.(), 0); return r }
        const store = { get: (k: string) => request(held.get(k)), put: (v: unknown, k: string) => { held.set(k, v); return request() }, delete: (k: string) => { held.delete(k); return request() } }
        return { open: () => { const db = { createObjectStore: () => undefined, transaction: () => { const tx: any = { objectStore: () => store, oncomplete: null }; setTimeout(() => tx.oncomplete?.(), 1); return tx }, close: () => undefined }; const req: any = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }; setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.() }, 0); return req } }
      })(),
      location: { hash: '#account', origin: 'https://cookrew.dev', hostname: 'cookrew.dev', protocol: 'https:', search: '', assign: (u: string) => calls.push('assign ' + u), reload: () => undefined },
      addEventListener: () => undefined,
      document: doc,
      fetch: async (url: string, init?: any) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url === '/v2/sessions') return { ok: false, status: 401, json: async () => ({ error: 'second_factor', message: 'One more step. Prove it is you.', next: ['totp', 'approve'], pending: 'p1', expiresAt: Date.now() + 600000 }) }
        return { ok: false, status: 401, json: async () => ({ error: 'unauthenticated' }) }
      }
    }
    sandbox.globalThis = sandbox
    sandbox.window = sandbox
    vm.runInNewContext(readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'site.js'), 'utf8'), sandbox)
    vm.runInNewContext(readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'factors.js'), 'utf8'), sandbox)
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2))
    console.log('passkey button:', doc.querySelectorAll('[data-passkey-signin]').length)
    doc.getElementById('acct-username')!.value = 'mira'
    doc.getElementById('acct-password')!.value = 'correct horse battery staple'
    doc.getElementById('acct-submit')!.dispatch('click')
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2))
    console.log('calls =', calls)
    console.log('errors =', errors)
    console.log('sheet text =', doc.getElementById('account-sheet')!.textContent.slice(0, 200))
    try {
      const d = await (sandbox.cookrewAccount as any).device()
      console.log('device =', JSON.stringify(d))
    } catch (e) {
      console.log('device threw =', e)
    }
  })
})
