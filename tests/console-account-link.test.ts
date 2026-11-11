import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { accountPageOf, readConsoleConfig } from '../src/renderer/src/console/console-config'

/**
 * "ACCOUNT & SECURITY" ON THE CONSOLE goes to the one place the account page
 * is: the auth host. It used to be `/me/account` on the page's own origin,
 * which was right while the registry served that page and is nothing on the
 * console, where every address is the console itself.
 */

const page = (metas: Record<string, string>): Pick<Document, 'querySelector'> =>
  ({
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1] ?? ''
      return name in metas ? { getAttribute: () => metas[name] } : null
    }
  }) as unknown as Pick<Document, 'querySelector'>

describe('the account page, from the console', () => {
  it('is the auth host’s /account, read from the page’s own configuration', () => {
    const config = readConsoleConfig(page({ 'cookrew-mode': 'console', 'cookrew-api': 'https://api.cookrew.dev', 'cookrew-auth': 'https://auth.cookrew.dev' }))
    expect(accountPageOf(config)).toBe('https://auth.cookrew.dev/account')
  })

  it('is nowhere on a page that is not the console: a machine’s own page and the app offer no such row', () => {
    expect(accountPageOf(readConsoleConfig(page({})))).toBeNull()
    expect(accountPageOf(readConsoleConfig(page({ 'cookrew-mode': 'console', 'cookrew-api': 'https://api.cookrew.dev', 'cookrew-auth': 'javascript:alert(1)' })))).toBeNull()
  })

  it('the menu draws the row from that address and from no address of its own', () => {
    const menu = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'HeaderMore.tsx'), 'utf8')
    expect(menu).not.toContain('href="/me/account"')
    expect(menu).toContain('accountPageOf(')
    expect(menu).toMatch(/href=\{accountPage\}/)
  })
})
