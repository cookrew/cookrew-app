import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { grantLedgerPath, serviceGrants } from '../src/main/service-grants-store'

/**
 * THE LEND, ON DISK. What a grant actually puts inside a sandbox, and the
 * budget that stops it happening forever.
 *
 * The secret-handling assertions here are the load-bearing ones: a lent value
 * must reach the session and must NOT reach a log, and the tests say so rather
 * than trusting a reviewer to notice.
 */

let base = ''
let sandbox = ''
let logged: string[] = []
const log = (message: string): void => {
  logged.push(message)
}

const SECRET = 'sk-test-not-a-real-key-000'

const writeConfig = (value: unknown): void =>
  writeFileSync(path.join(base, 'service-grants.json'), JSON.stringify(value), { mode: 0o600 })

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'grants-'))
  sandbox = mkdtempSync(path.join(tmpdir(), 'grant-sandbox-'))
  logged = []
  // The store reads COOKREW_SERVICE_GRANTS when set; a stray one in the
  // developer's own shell would point every test at their real grants.
  delete process.env.COOKREW_SERVICE_GRANTS
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
})

describe('a service that was lent nothing', () => {
  it('serves exactly as it did before grants existed', () => {
    const grants = serviceGrants(base, log)
    expect(grants.grantFor('svc-x')).toBeNull()
    expect(grants.envKeysFor('svc-x')).toEqual([])
    // No budget to exceed — a crew that needs no credential is not bounded by
    // one, or every existing served crew would stop at the first session.
    expect(grants.allowsNewSession('svc-x')).toBe(true)
    expect(() => grants.provision('svc-x', sandbox)).not.toThrow()
    // And nothing was spent, because nothing was lent.
    expect(existsSync(grantLedgerPath(base))).toBe(false)
  })

  it('is silent about a missing config file, and loud about an unreadable one', () => {
    serviceGrants(base, log).grantFor('svc-x')
    expect(logged).toEqual([])
    writeFileSync(path.join(base, 'service-grants.json'), 'not json{{')
    serviceGrants(base, log).grantFor('svc-x')
    expect(logged.join(' ')).toMatch(/ignoring/)
  })
})

describe('env grants', () => {
  it('forwards a name from the owner’s own environment', () => {
    writeConfig({ 'svc-x': { env: ['ANTHROPIC_API_KEY'], maxSessions: 2 } })
    const grants = serviceGrants(base, log)
    expect(grants.envKeysFor('svc-x')).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('lends every key of an envFile, and its VALUES, without storing them again', () => {
    const envFile = path.join(base, 'qwen.env')
    writeFileSync(envFile, `export ANTHROPIC_BASE_URL=https://example.invalid\nexport ANTHROPIC_API_KEY=${SECRET}\n`, { mode: 0o600 })
    writeConfig({ 'svc-x': { envFile, maxSessions: 2 } })
    const grants = serviceGrants(base, log)
    expect([...grants.envKeysFor('svc-x')].sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL'
    ])
    expect(grants.ownerEnvFor('svc-x').ANTHROPIC_API_KEY).toBe(SECRET)
    // The grant file names the path; the secret stays in the file the owner
    // already keeps, never copied into a second place we would have to protect.
    expect(readFileSync(path.join(base, 'service-grants.json'), 'utf8')).not.toContain(SECRET)
  })

  it('NEVER logs a lent value, whatever it does with the name', () => {
    const envFile = path.join(base, 'qwen.env')
    writeFileSync(envFile, `ANTHROPIC_API_KEY=${SECRET}\n`, { mode: 0o600 })
    writeConfig({ 'svc-x': { envFile, env: ['HOME'], maxSessions: 1 } })
    const grants = serviceGrants(base, log)
    grants.envKeysFor('svc-x')
    grants.ownerEnvFor('svc-x')
    grants.provision('svc-x', sandbox)
    expect(logged.join('\n')).not.toContain(SECRET)
    // It did complain about HOME, so this is not passing by saying nothing.
    expect(logged.join(' ')).toMatch(/HOME/)
  })

  it('warns once when a lent credential file is readable by other users', () => {
    const envFile = path.join(base, 'loose.env')
    writeFileSync(envFile, 'K=v\n', { mode: 0o644 })
    writeConfig({ 'svc-x': { envFile, maxSessions: 1 } })
    serviceGrants(base, log).envKeysFor('svc-x')
    expect(logged.join(' ')).toMatch(/readable by other users/)
    // Warned, not refused: it is the owner's file and their call.
    expect(serviceGrants(base, log).envKeysFor('svc-x')).toEqual(['K'])
  })

  it('a refused grant lends no names at all', () => {
    writeConfig({ 'svc-x': { env: ['ANTHROPIC_API_KEY'] } })
    const grants = serviceGrants(base, log)
    expect(grants.envKeysFor('svc-x')).toEqual([])
    expect(logged.join(' ')).toMatch(/maxSessions/)
  })
})

describe('file grants', () => {
  it.skipIf(process.platform === 'win32')('copies a lent file into the sandbox at 0600', () => {
    const source = path.join(base, 'models.json')
    writeFileSync(source, '{"providers":{}}', { mode: 0o644 })
    writeConfig({
      'svc-x': { files: [{ from: source, to: '.pi/agent/models.json' }], maxSessions: 1 }
    })
    const grants = serviceGrants(base, log)
    expect(grants.filesFor('svc-x')).toEqual([
      { from: source, to: '.pi/agent/models.json' }
    ])
    expect(existsSync(grantLedgerPath(base))).toBe(false)
    grants.provision('svc-x', sandbox)
    const landed = path.join(sandbox, '.pi', 'agent', 'models.json')
    expect(readFileSync(landed, 'utf8')).toBe('{"providers":{}}')
    // Forced, not preserved: the copy is a credential by assumption, even when
    // the original was not protected.
    expect(statSync(landed).mode & 0o777).toBe(0o600)
  })

  it('refuses to mint when a lent file is not on this machine', () => {
    writeConfig({
      'svc-x': { files: [{ from: path.join(base, 'gone.json'), to: 'x.json' }], maxSessions: 1 }
    })
    expect(() => serviceGrants(base, log).provision('svc-x', sandbox)).toThrow(/not on this machine/)
    // And the session is NOT spent — a caller who got nothing must not have
    // burned one of the owner's.
    expect(existsSync(grantLedgerPath(base))).toBe(false)
  })

  it('cannot be talked into writing outside the sandbox', () => {
    const source = path.join(base, 'secret')
    writeFileSync(source, 'x')
    // readGrant drops this entry, so nothing is copied and the mint proceeds
    // with the rest of the grant — the refusal is in the config layer, and this
    // asserts the consequence rather than the mechanism.
    writeConfig({
      'svc-x': { files: [{ from: source, to: '../escaped' }], maxSessions: 1 }
    })
    serviceGrants(base, log).provision('svc-x', sandbox)
    expect(existsSync(path.join(path.dirname(sandbox), 'escaped'))).toBe(false)
    expect(logged.join(' ')).toMatch(/inside the session/)
  })
})

describe('the budget', () => {
  const lend = (maxSessions: number): void =>
    writeConfig({ 'svc-x': { env: ['ANTHROPIC_API_KEY'], maxSessions } })

  it('allows exactly as many sessions as it says, then stops', () => {
    lend(2)
    const grants = serviceGrants(base, log)
    expect(grants.allowsNewSession('svc-x')).toBe(true)
    grants.provision('svc-x', sandbox)
    expect(grants.allowsNewSession('svc-x')).toBe(true)
    grants.provision('svc-x', sandbox)
    expect(grants.allowsNewSession('svc-x')).toBe(false)
    expect(() => grants.provision('svc-x', sandbox)).toThrow(/spent its grant/)
  })

  it('SPENT IS SPENT — the ledger is not refunded and survives a new store', () => {
    lend(1)
    serviceGrants(base, log).provision('svc-x', sandbox)
    // A fresh store over the same base, as a restart would build.
    expect(serviceGrants(base, log).allowsNewSession('svc-x')).toBe(false)
  })

  it('takes a raised budget WITHOUT a restart — the file is read per call', () => {
    lend(1)
    const grants = serviceGrants(base, log)
    grants.provision('svc-x', sandbox)
    expect(grants.allowsNewSession('svc-x')).toBe(false)
    lend(3)
    expect(grants.allowsNewSession('svc-x')).toBe(true)
  })

  it('takes a REVOKED grant without a restart too', () => {
    lend(3)
    const grants = serviceGrants(base, log)
    expect(grants.envKeysFor('svc-x')).toEqual(['ANTHROPIC_API_KEY'])
    writeConfig({})
    expect(grants.envKeysFor('svc-x')).toEqual([])
  })

  it('counts per service, so one crew cannot spend another’s', () => {
    writeConfig({
      'svc-a': { env: ['K'], maxSessions: 1 },
      'svc-b': { env: ['K'], maxSessions: 1 }
    })
    const grants = serviceGrants(base, log)
    grants.provision('svc-a', sandbox)
    expect(grants.allowsNewSession('svc-a')).toBe(false)
    expect(grants.allowsNewSession('svc-b')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('writes the ledger 0600 and never touches the owner’s own file', () => {
    lend(2)
    const before = readFileSync(path.join(base, 'service-grants.json'), 'utf8')
    serviceGrants(base, log).provision('svc-x', sandbox)
    expect(statSync(grantLedgerPath(base)).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(base, 'service-grants.json'), 'utf8')).toBe(before)
  })

  it('starts over rather than blocking when the ledger is corrupt', () => {
    lend(1)
    mkdirSync(base, { recursive: true })
    writeFileSync(grantLedgerPath(base), 'not json{{')
    const grants = serviceGrants(base, log)
    // The ledger is a spend counter, not the authorisation — the grant file is,
    // and it is intact. Refusing here would let a corrupt counter revoke a
    // grant the owner still means.
    expect(grants.allowsNewSession('svc-x')).toBe(true)
    grants.provision('svc-x', sandbox)
    expect(grants.allowsNewSession('svc-x')).toBe(false)
  })
})
