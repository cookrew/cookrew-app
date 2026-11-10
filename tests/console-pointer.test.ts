import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { consolePointerFor } from '../src/main/console-pointer'

/**
 * A MACHINE OF AN ACCOUNT DOES NOT HAND OUT ITS APP ON :8643 (0.6.0, F2). Its
 * way in is the console. Opened at its own address from another device it
 * answers one sentence saying so, with the link; its API answers as before
 * (the console's direct path goes there). A machine with no account still
 * serves its page: scanning its QR on the same Wi-Fi is the only door it has.
 */

const M = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const from = (over: Partial<Parameters<typeof consolePointerFor>[0]> = {}): string | null =>
  consolePointerFor({ signedIn: true, remoteAddress: '192.168.1.50', viaRelay: false, consoleOrigin: 'https://console.cookrew.dev', machineId: M, machineName: 'Studio Mac', ...over })

describe('the root page of a machine of an account', () => {
  it('is one sentence and the link to this machine on the console', () => {
    const page = from() ?? ''
    expect(page).toContain(`href="https://console.cookrew.dev/d/${M}"`)
    expect(page).toContain('Studio Mac')
    expect(page).toContain('console.cookrew.dev')
  })

  it('carries no script, no token and nothing of the app', () => {
    const page = from() ?? ''
    expect(page).not.toMatch(/<script/i)
    expect(page).not.toMatch(/token|pair=/i)
    expect(page).not.toContain('/assets/')
    expect(page).not.toContain('COOKREW_MOBILE')
  })

  it('writes the machine’s name and the console’s address as text, whatever they contain', () => {
    const page = from({ machineName: '<img src=x onerror=alert(1)>"', consoleOrigin: 'https://console.cookrew.dev' }) ?? ''
    expect(page).not.toContain('<img')
    expect(page).toContain('&lt;img')
    // A console address that is not an https origin is not linked to: the page says the plain name instead.
    const odd = from({ consoleOrigin: 'javascript:alert(1)' }) ?? ''
    expect(odd).not.toContain('javascript:')
    expect(odd).toContain('console.cookrew.dev')
  })

  it('points at the console’s first level when the machine’s id is not known', () => {
    expect(from({ machineId: null })).toContain('href="https://console.cookrew.dev/"')
  })
})

describe('who still gets the page', () => {
  it('a machine with no account serves it to everyone, as it always did', () => {
    expect(from({ signedIn: false })).toBeNull()
    expect(from({ signedIn: false, remoteAddress: '127.0.0.1' })).toBeNull()
  })

  it('this machine’s own operator, on loopback: the page a developer and the perf harness open', () => {
    expect(from({ remoteAddress: '127.0.0.1' })).toBeNull()
    expect(from({ remoteAddress: '::1' })).toBeNull()
    expect(from({ remoteAddress: '::ffff:127.0.0.1' })).toBeNull()
  })

  it('but not somebody reaching loopback through the relay’s bridge: that is the most remote client there is', () => {
    expect(from({ remoteAddress: '127.0.0.1', viaRelay: true })).not.toBeNull()
  })
})

describe('the server', () => {
  it('asks before it serves the page, on both ways it serves it', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'main', 'mobile-server.ts'), 'utf8')
    const branch = src.slice(src.indexOf("if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))"))
    const pointer = branch.indexOf('consolePointerFor(')
    expect(pointer).toBeGreaterThan(-1)
    expect(pointer).toBeLessThan(branch.indexOf('serveRendererDev('))
    expect(pointer).toBeLessThan(branch.indexOf('serveRendererIndex('))
  })

  it('never serves a page as an asset: another spelling of the page’s path does not find it', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'main', 'mobile-server.ts'), 'utf8')
    const assets = src.slice(src.indexOf('function serveRendererAsset('))
    const refusal = assets.indexOf("if (path.extname(file).toLowerCase() === '.html') return false")
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(assets.indexOf('sendBody('))
  })

  it('wires no half that could admit a device nobody can use: a stray "use Wi-Fi" request is answered as not wired', () => {
    const main = readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    expect(main).not.toMatch(/\n  reach: \{/)
    const requests = readFileSync(path.join(__dirname, '..', 'src', 'main', 'requests.ts'), 'utf8')
    // Refused before anything is minted.
    expect(requests.indexOf("if (reach === undefined) return { ok: false, reason: 'not_wired' }")).toBeLessThan(requests.indexOf('reach.admit('))
  })
})
