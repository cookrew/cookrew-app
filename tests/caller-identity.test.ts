import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  sessionIdFromCommandLine,
  resolveCallerTerminalId
} from '../src/shared/caller-identity'
import { callerSub, callingIdentity } from '../src/main/caller-identity'
import { writeAccount } from '../src/main/account'
import { SAFE_SUB } from '../src/main/served-callers'

describe('sessionIdFromCommandLine — reading a claude session out of an argv', () => {
  it('finds a --session-id', () => {
    expect(
      sessionIdFromCommandLine('claude.exe --session-id 413c8c39-60cf-4d5a-8fb2-961f1445bfee')
    ).toBe('413c8c39-60cf-4d5a-8fb2-961f1445bfee')
  })

  it('finds a --resume, which is the same fact spelled differently', () => {
    expect(
      sessionIdFromCommandLine(
        'claude --permission-mode bypassPermissions --resume ca205777-aabe-4984-84f0-041a19fe8d02'
      )
    ).toBe('ca205777-aabe-4984-84f0-041a19fe8d02')
  })

  it('answers null when the argv carries no session', () => {
    expect(sessionIdFromCommandLine('zsh -l')).toBeNull()
    expect(sessionIdFromCommandLine('')).toBeNull()
  })

  it('refuses anything that is not a uuid, rather than guessing', () => {
    // A loose match here would let an unrelated flag value become an identity.
    expect(sessionIdFromCommandLine('claude --session-id not-a-uuid')).toBeNull()
    expect(sessionIdFromCommandLine('claude --session-id 413c8c39')).toBeNull()
  })
})

const NODES = [
  { id: 'node-cookrew', claudeSessionId: '413c8c39-60cf-4d5a-8fb2-961f1445bfee' },
  { id: 'node-goat', claudeSessionId: 'ca205777-aabe-4984-84f0-041a19fe8d02' },
  { id: 'node-idle', claudeSessionId: null }
]

const resolve = (envTerminalId: string, sessionId: string | null) =>
  resolveCallerTerminalId({ envTerminalId, sessionId, terminals: NODES })

describe('resolveCallerTerminalId — the binding outranks the environment', () => {
  it('repairs the env when the session says a different node', () => {
    // The measured failure: a background-spawned session inherits the env of
    // whichever pane hosts its process tree, so the CLI acts as the wrong card
    // in the wrong workspace — and succeeds.
    const out = resolve('node-goat', '413c8c39-60cf-4d5a-8fb2-961f1445bfee')
    expect(out.terminalId).toBe('node-cookrew')
    expect(out.repairedFrom).toBe('node-goat')
  })

  it('agrees silently when env and binding already match', () => {
    const out = resolve('node-goat', 'ca205777-aabe-4984-84f0-041a19fe8d02')
    expect(out.terminalId).toBe('node-goat')
    expect(out.repairedFrom).toBeNull()
  })

  it('keeps the env when no session was supplied', () => {
    // Non-claude harnesses and older CLIs send nothing; they must not regress.
    const out = resolve('node-goat', null)
    expect(out.terminalId).toBe('node-goat')
    expect(out.repairedFrom).toBeNull()
  })

  it('keeps the env when the session is bound to no node', () => {
    // Measured: one background session belonged to no card at all. An unbound
    // session is not evidence about identity, so it must not blank the caller.
    const out = resolve('node-goat', 'a7b45821-0000-0000-0000-000000000000')
    expect(out.terminalId).toBe('node-goat')
    expect(out.repairedFrom).toBeNull()
  })

  it('resolves an identity even when the env is empty', () => {
    const out = resolve('', '413c8c39-60cf-4d5a-8fb2-961f1445bfee')
    expect(out.terminalId).toBe('node-cookrew')
    expect(out.repairedFrom).toBeNull()
  })

  it('never matches a node that has no session bound', () => {
    // null === null must not make every unbound card a candidate.
    const out = resolve('node-goat', null)
    expect(out.terminalId).not.toBe('node-idle')
  })

  it('is a pure read — it does not mutate the terminal list', () => {
    const before = JSON.stringify(NODES)
    resolve('node-goat', '413c8c39-60cf-4d5a-8fb2-961f1445bfee')
    expect(JSON.stringify(NODES)).toBe(before)
  })
})

describe('callingIdentity — the account is the caller, the OS user is the fallback', () => {
  const dir = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-calling-'))

  it('falls back to the OS username when no account has been minted', () => {
    const base = dir()
    const out = callingIdentity({ baseDir: base, osUser: 'Drej.Smith' })
    expect(out).toMatchObject({ sub: 'drej-smith', source: 'os-user', key: null })
    rmSync(base, { recursive: true, force: true })
  })

  it('AN ACCOUNT WINS — two people called `admin` are not one caller', () => {
    const base = dir()
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    writeAccount(
      {
        handle: 'mira',
        deviceId: 'd_1',
        kind: 'desktop',
        name: 'MacBook',
        privateKeyJwk: privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
        publicKeyJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
        registry: 'https://registry.test',
        mintedAt: '2026-09-05T00:00:00.000Z'
      },
      base
    )
    // The OS user is `admin` on this machine and is IGNORED: the minted name
    // is the one the registry made unique, so it is the one a door seats.
    const out = callingIdentity({ baseDir: base, osUser: 'admin' })
    expect(out.sub).toBe('mira')
    expect(out.source).toBe('account')
    // One key for one name: the account key signs, not a per-door key.
    expect(out.key).not.toBeNull()
    expect(out.key?.jwk).toEqual(publicKey.export({ format: 'jwk' }))
    rmSync(base, { recursive: true, force: true })
  })

  it('leaves the sub a door will accept unchanged', () => {
    const base = dir()
    // A handle's shape is a subset of the door's SAFE_SUB, so it survives
    // verbatim — normalising a name the registry minted could only rename it.
    expect(SAFE_SUB.test('mira-2')).toBe(true)
    expect(callerSub('mira-2')).toBe('mira-2')
    rmSync(base, { recursive: true, force: true })
  })
})
