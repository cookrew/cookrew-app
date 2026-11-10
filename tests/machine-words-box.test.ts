// BOX ROUND 3, BUG 6. On a Linux box with a local registry the app went on
// saying THIS MAC, ADD A MAC and "It goes only to cookrew.dev", and the sign-in
// field offered the owner's own handle.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliCopy } from '../src/shared/account-copy'
import {
  hostRegistry,
  machineCopy,
  machineTable,
  registryArgument,
  registryCopy,
  registryFromArgv,
  registryWord
} from '../src/shared/machine-words'
import { mePage } from '../registry/src/site-account'
import { ASSETS } from '../registry/src/assets-bundle'

afterEach(() => vi.unstubAllGlobals())

const hold = (origin: string): void => void vi.stubGlobal('cookrewRegistry', origin)

describe('the word for the registry', () => {
  it('is the host of the origin set', () => {
    expect(registryWord('http://127.0.0.1:8799')).toBe('127.0.0.1:8799')
    expect(registryWord('https://registry.example.org/')).toBe('registry.example.org')
  })

  it('is nothing for cookrew.dev, an empty setting or nonsense: the sentences stand', () => {
    expect(registryWord('https://cookrew.dev')).toBeUndefined()
    expect(registryWord('')).toBeUndefined()
    expect(registryWord(undefined)).toBeUndefined()
    expect(registryWord('not a url')).toBeUndefined()
  })

  it('replaces the name wherever a sentence says it, and only the name', () => {
    expect(registryCopy('It goes only to cookrew.dev.', '127.0.0.1:8799')).toBe('It goes only to 127.0.0.1:8799.')
    expect(registryCopy('Open cookrew.dev/join to start.', 'r.example')).toBe('Open r.example/join to start.')
    expect(registryCopy('Your Cookrew account.', 'r.example')).toBe('Your Cookrew account.')
    expect(registryCopy('It goes only to cookrew.dev.', undefined)).toBe('It goes only to cookrew.dev.')
  })

  it('never touches an origin: the mismatch warning exists to show two of them', () => {
    const said = 'Signed in at https://cookrew.dev; the app is pointed at http://127.0.0.1:8799.'
    expect(registryCopy(said, '127.0.0.1:8799')).toBe(said)
  })

  it('crosses the preload as an argument and comes back', () => {
    expect(registryFromArgv(['electron', registryArgument('http://127.0.0.1:8799')])).toBe('http://127.0.0.1:8799')
    expect(registryFromArgv(['electron'])).toBe('')
  })
})

describe('a table on a box with another registry', () => {
  const table = { hint: 'It goes only to cookrew.dev.', mine: 'This Mac joins.' } as const

  it('says the registry the app really talks to, on any platform', () => {
    hold('http://127.0.0.1:8799')
    expect(hostRegistry()).toBe('127.0.0.1:8799')
    expect(machineTable(table, 'linux')).toEqual({ hint: 'It goes only to 127.0.0.1:8799.', mine: 'This machine joins.' })
    expect(machineTable(table, 'darwin').hint).toBe('It goes only to 127.0.0.1:8799.')
    expect(machineCopy('cookrew.dev did not answer.', undefined)).toBe('127.0.0.1:8799 did not answer.')
  })

  it('is the same table back when the registry is cookrew.dev on a Mac', () => {
    hold('https://cookrew.dev')
    expect(machineTable(table, 'darwin')).toBe(table)
  })
})

describe('a terminal sentence', () => {
  it('names the registry and the machine, not a Mac and cookrew.dev', () => {
    const said = cliCopy('said.signed-in', 'linux', { handle: 'mira', device: 'box' }, '127.0.0.1:8799')
    expect(said).toBe('Signed in as @mira. 127.0.0.1:8799 shows this machine as box.')
  })
  it('leaves the home registry as written', () => {
    expect(cliCopy('said.signed-in', 'darwin', { handle: 'mira', device: 'Mac mini' })).toBe('Signed in as @mira. cookrew.dev shows this Mac as Mac mini.')
  })
  it('login-cli says which registry it is on, every time', () => {
    const source = readFileSync('src/main/login-cli.ts', 'utf8')
    expect(source.match(/\bcliCopy\(/g)).toHaveLength(1)
    expect(source).toMatch(/registryWord\(registryOrigin\(\)\)/)
  })
})

describe('the app’s log', () => {
  it('names no registry it did not ask', () => {
    const source = readFileSync('src/main/desktop-cert.ts', 'utf8')
    expect(source.split('\n').filter((line) => /(note|sayOnce)\(.*cookrew\.dev/.test(line))).toEqual([])
  })
})

describe('the desktop’s own words', () => {
  const tsxUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return tsxUnder(full)
      return entry.name.endsWith('.tsx') ? [full] : []
    })
  const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*|\{\/\*)/.test(line)

  it('no component writes the machine word past machineCopy', () => {
    // use/ is the Mac's own unlock and remote hand: neither exists elsewhere.
    const files = tsxUnder('src/renderer/src').filter((file) => !file.includes(`${path.sep}use${path.sep}`))
    const raw = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !isComment(line) && /\b(this Mac|This Mac|THIS MAC|A MAC)\b/.test(line) && !/machineCopy|\bword\(/.test(line))
        .map((line) => `${file}: ${line.trim()}`)
    )
    expect(raw).toEqual([])
  })

  it('the sign-in field offers nobody’s handle', () => {
    const source = readFileSync('src/renderer/src/account/SheetPanes.tsx', 'utf8')
    expect(source).not.toContain('@drej')
    expect(source).toContain('placeholder="@yourname"')
  })
})

describe('the account page, which cannot know what a desktop runs', () => {
  const desktop = { deviceId: '11111111-1111-4111-8111-111111111111', name: 'Linux · box', workspaces: [], addresses: [] }
  // The page lives on the auth host only (0.6.0); its machines section went with the registry's /me.
  const standalone = { site: 'https://cookrew.dev', console: 'https://console.cookrew.dev', home: '/account' }

  it('says machine across the whole page, and keeps a device’s own name', () => {
    const account = {
      username: 'mira', displayName: '', claimedAt: 0, avatar: null, recovery: [],
      devices: [{ id: 'one', kind: 'desktop', name: 'Mac mini', lastSeenAt: 0 }],
      desktops: [{ ...desktop, name: 'Linux · box' }]
    }
    const { body } = mePage({ account: account as never, currentDeviceId: 'one' }, standalone) as unknown as { body: string }
    expect(body).toContain('Mac mini')
    const words = body.replaceAll('Mac mini', '')
    expect(words.match(/.{30}\bMac\b.{20}/g) ?? []).toEqual([])
  })

  it('tells nobody a password goes to one named site', () => {
    const me = readFileSync('registry/src/site-account.ts', 'utf8')
    expect(me).not.toContain('It goes only to cookrew.dev')
    expect(me).not.toMatch(/data-add-device="desktop">Add a Mac/)
    expect(me).not.toContain('<span class="chip">Mac</span>')
    expect(ASSETS['factors.js'].body).not.toContain('goes only to cookrew.dev')
  })
})
