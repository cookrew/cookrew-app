// HP round, lane hp-security: the deny list, the scrub on its surfaces, the
// scoped key, and the wiring.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { confinedSpawn, sandboxRoot, seatbeltProfile, serviceRoot } from '../src/main/session-sandbox'
import { scrubInboxRow, scrubSousResult } from '../src/main/scrub-surfaces'
import { createScrubber, REDACTED } from '../src/main/scrub'
import { SOUS_GATEWAY_KEY_FALLBACK, sousGatewayKey } from '../src/main/sous-config'
import type { InboxRow } from '../src/shared/inbox-rank'

describe('the served deny list (item 1)', () => {
  const paths = ownerSecretPaths('/home/owner/.cookrew', '/home/owner', undefined, { XDG_CONFIG_HOME: '/xdg' })
  it('names Magpie\'s config under ~/.config and under XDG, the Sous ledger and facts, the route file and the Sous key', () => {
    for (const p of [
      '/home/owner/.config/magpie',
      '/xdg/magpie',
      '/home/owner/.cookrew/sous-decisions.jsonl',
      '/home/owner/.cookrew/sous-magpie.json',
      '/home/owner/.cookrew/route.json',
      '/home/owner/.cookrew/sous-gateway.key'
    ]) {
      expect(paths).toContain(p)
    }
    // Still there from before.
    expect(paths).toContain('/home/owner/.cookrew/secrets')
    expect(paths).toContain('/home/owner/.cookrew/pairing-token')
  })
  it('no XDG dir when the variable is unset or empty', () => {
    expect(ownerSecretPaths('/h/.cookrew', '/h', undefined, {})).not.toContain('/magpie')
    expect(ownerSecretPaths('/h/.cookrew', '/h', undefined, { XDG_CONFIG_HOME: '' }).filter((p) => p.endsWith('/magpie'))).toEqual(['/h/.config/magpie'])
  })
  it('the profile denies each, after the broad read allow', () => {
    const profile = seatbeltProfile({ sandbox: '/s/svc/a', siblingRoot: '/s/svc', sessionsRoot: '/s', secretPaths: paths })
    for (const p of ['/home/owner/.config/magpie', '/xdg/magpie', '/home/owner/.cookrew/sous-decisions.jsonl', '/home/owner/.cookrew/route.json']) {
      const rule = `(deny file-read* (subpath "${p}") (literal "${p}"))`
      expect(profile).toContain(rule)
      expect(profile.indexOf(rule)).toBeGreaterThan(profile.indexOf('(allow file-read*)'))
    }
  })
})

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
describe.runIf(onMac)('a served process cannot read Magpie\'s providers (item 1, live probe)', () => {
  let base = ''
  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-hp-sbx-')))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('sandbox-exec under the profile is refused the file a plain shell can read', () => {
    const home = path.join(base, 'home')
    const providers = path.join(home, '.config', 'magpie', 'providers.json')
    mkdirSync(path.dirname(providers), { recursive: true })
    writeFileSync(providers, '{"providers":[{"key":"sk-FAKE-upstream-key"}]}')
    chmodSync(providers, 0o644)
    mkdirSync(path.join(base, 'sessions'), { recursive: true })
    const sandbox = sandboxRoot(base, 'svc', 'ana-1')
    const siblings = realpathSync(serviceRoot(base, 'svc'))
    const profile = path.join(sandbox, '..', 'ana-1.sb')
    writeFileSync(
      profile,
      seatbeltProfile({
        sandbox,
        siblingRoot: siblings,
        sessionsRoot: realpathSync(path.join(base, 'sessions')),
        secretPaths: ownerSecretPaths(path.join(home, '.cookrew'), home, undefined, {})
      })
    )
    const script = `(cat "${providers}" >/dev/null 2>&1 && echo READ-OK || echo READ-BLOCKED); (ls "${path.dirname(providers)}" >/dev/null 2>&1 && echo LIST-OK || echo LIST-BLOCKED)`
    const spawn = confinedSpawn(profile, '/bin/sh', ['-c', script])
    let out = ''
    try {
      out = execFileSync(spawn.file, spawn.args, { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
    expect(out).toContain('READ-BLOCKED')
    expect(out).toContain('LIST-BLOCKED')
    expect(out).not.toContain('READ-OK')
    // And the same file reads fine outside the sandbox: the deny is the sandbox's, not the mode's.
    expect(readFileSync(providers, 'utf8')).toContain('sk-FAKE')
  })
})

describe('the scrub on its surfaces (item 2)', () => {
  const scrub = createScrubber({ secrets: () => ['sk_live_SEALEDVALUE_1234'], env: {} })
  it('an inbox row: reasons and the proposal text, nothing else touched', () => {
    const row = {
      nodeId: 'n', nodeName: 'Tinker', nodeKind: 'terminal', workspaceId: 'w', workspaceName: 'W', kind: 'secret', kinds: ['secret'],
      reasons: ['needs sk_live_SEALEDVALUE_1234', 'waiting'], since: 1, waitMinutes: 2, served: false, blockedDownstream: 0, score: 1, slot: 'stripe-key',
      text: 'use sk_live_SEALEDVALUE_1234 please'
    } as unknown as InboxRow & { text: string }
    const out = scrubInboxRow(row, scrub)
    expect(out.reasons).toEqual([`needs ${REDACTED}`, 'waiting'])
    expect(out.text).toBe(`use ${REDACTED} please`)
    expect(out.slot).toBe('stripe-key')
    expect(out.nodeName).toBe('Tinker')
  })
  it('a Sous result: spoken, the choices, the decision sentence', () => {
    const out = scrubSousResult(
      { intent: 'decide', spoken: 'the key is sk_live_SEALEDVALUE_1234', choices: ['sk-abcdefghijklmnop', 'Forge'], decision: { token: 't', holdMs: 1, sentence: 'send sk_live_SEALEDVALUE_1234' } as never },
      scrub
    )
    expect(out.spoken).toBe(`the key is ${REDACTED}`)
    expect(out.choices).toEqual([REDACTED, 'Forge'])
    expect(out.decision?.sentence).toBe(`send ${REDACTED}`)
    expect(out.decision?.token).toBe('t')
  })
  it('is wired where text leaves main: the audit details, the inbox rows, every Sous door, the recruit brief', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('details: scrub(')
    expect(main).toContain('}).map((row) => scrubInboxRow(row, scrub))')
    expect(main).toContain('handle: async (input) => scrubSousResult(await sous.handle(input), scrub)')
    expect(main.split('sous: sousDoor,').length - 1).toBe(2)
    expect(main).toContain("sousDoor.handle({")
    expect(main).not.toMatch(/\n\s+sous\.handle\(\{/)
    expect(main).toContain('recruitPatch(scrub(brief))')
    expect(main).toContain('tokens: () => [activePairingTokenValue(), routeService.gatewayKey()]')
  })
})

describe('the scoped gateway key for Sous (item 3)', () => {
  it('reads ~/.cookrew/sous-gateway.key when present, else the local token', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-sous-key-'))
    expect(sousGatewayKey(base)).toBe(SOUS_GATEWAY_KEY_FALLBACK)
    writeFileSync(path.join(base, 'sous-gateway.key'), 'sk-magpie-SCOPED-abcdef\n', { mode: 0o600 })
    expect(sousGatewayKey(base)).toBe('sk-magpie-SCOPED-abcdef')
    writeFileSync(path.join(base, 'sous-gateway.key'), '\n')
    expect(sousGatewayKey(base)).toBe(SOUS_GATEWAY_KEY_FALLBACK)
  })
  it('the script mints, stores at 0600 without printing, and limits the key to the Sous groups', () => {
    const script = readFileSync('scripts/magpie-sous-key.sh', 'utf8')
    expect(script).toContain('umask 077')
    expect(script).toContain('magpie gateway-key add "$NAME"')
    expect(script).toContain('> "$FILE.tmp"')
    expect(script).toContain('chmod 600 "$FILE.tmp"')
    expect(script).toContain('magpie gateway-key models "$ID" $GROUPS_ALLOWED')
    expect(script).toContain('group/jevs group/auto')
    expect(script).not.toMatch(/cat "\$FILE"|echo .*\$\(cat/)
  })
})
