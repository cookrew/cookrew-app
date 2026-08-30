import { describe, expect, it } from 'vitest'
import {
  sessionIdFromCommandLine,
  resolveCallerTerminalId
} from '../src/shared/caller-identity'

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
