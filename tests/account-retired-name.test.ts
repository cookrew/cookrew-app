// BOX ROUND 3, BUG 8. After a delete the name stays reserved for good. The
// create sheet showed TAKEN, YOURS? and "sign in with your password", and that
// sign-in can only fail. A retired name is not a taken name: nobody can sign in
// to it, so the sheet offers no such door. Loopback only.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Accounts } from '../src/main/account-v2'
import { registerView } from '../src/renderer/src/account/account-store'
import { handleView } from '../src/renderer/src/account/provider-store'
import { accountCopy } from '../src/shared/account-copy'
import { ASSETS } from '../registry/src/assets-bundle'
import { tempBase } from './support/idv2'

const fields = (check: 'retired' | 'taken') => ({ username: 'gonename', check, password: '', confirm: '' }) as never

let server: Server | null = null
const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0)) clean()
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
})

async function answering(status: number): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(status)
    response.end()
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('the desktop’s check', () => {
  it('hears a retired name from the registry’s 410', async () => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    const accounts = new Accounts({ base, origin: await answering(410) })
    expect(await accounts.checkUsername('gonename')).toBe('retired')
  })
})

describe('the create sheet on a retired name', () => {
  const view = registerView(fields('retired'))

  it('says the name cannot be used, and invites nothing', () => {
    expect(view.username.tone).toBe('bad')
    expect(view.username.tag).toBe('unavailable')
    expect(view.username.note).toBe(accountCopy('d9.crossing.retired', { handle: 'gonename' }))
    expect(view.username.note).not.toMatch(/sign in/i)
  })

  it('keeps its primary down: there is no door behind it', () => {
    expect(view.crossesToSignIn).toBe(false)
    expect(view.canGo).toBe(false)
    expect(view.primary).not.toMatch(/SIGN IN/)
  })

  it('a taken name still crosses', () => {
    expect(registerView(fields('taken')).crossesToSignIn).toBe(true)
  })
})

describe('the provider’s name card on a retired name', () => {
  it('asks for another name', () => {
    expect(handleView('gonename', 'retired')).toMatchObject({ canGo: false, tone: 'bad' })
    expect(handleView('gonename', 'retired').note).toContain('@gonename')
  })
})

describe('the site’s own sheet', () => {
  it('never reads the 410 as free', () => {
    const source = readFileSync('registry/assets/site.js', 'utf8')
    expect(source.indexOf('status === 410')).toBeLessThan(source.indexOf("res.status === 200 ? 'taken' : 'free'"))
    expect(ASSETS['site.js'].body).toMatch(/status === 410/)
  })
})
