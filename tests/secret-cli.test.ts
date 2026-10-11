// `cookrew secret read <name>`: the value and nothing else, to the owner's
// panes only, with a line in the log every time.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cmdSecret, SECRET_EXIT, SecretCliError, secretAuditDetails, type SecretAudit } from '../src/main/secret-cli'
import { createSecretsStore } from '../src/main/secrets-store'
import { paneEnv } from '../src/main/pane-env'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'

const VALUE = 'sk_live_51Hx9QxTESTVALUE0000'

const pane = (over: Partial<TerminalNodeData> = {}): TerminalNodeData =>
  ({ kind: 'terminal', id: 't-owner', name: 'Tinker', preset: 'claude', command: 'claude', cwd: '/', orch: false, role: null, ...over }) as TerminalNodeData

const harness = (me: TerminalNodeData = pane()) => {
  const store = createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-cli-')) })
  const audits: SecretAudit[] = []
  const deps = { secrets: store, self: () => me, audit: (event: SecretAudit) => audits.push(event) }
  const run = (...args: string[]) =>
    cmdSecret({ id: 'r', terminalId: me.id, cmd: 'secret', args, flags: {} } as unknown as CliRequest, deps)
  return { store, audits, run }
}

const failure = (fn: () => unknown): SecretCliError => {
  try {
    fn()
  } catch (error) {
    if (error instanceof SecretCliError) return error
    throw error
  }
  throw new Error('expected a SecretCliError')
}

describe('cookrew secret read', () => {
  it('prints the value and nothing else, and logs secret.read with the pane and the name', () => {
    const { store, audits, run } = harness()
    store.put('stripe-key', VALUE)
    expect(run('read', 'stripe-key')).toBe(VALUE)
    expect(audits).toEqual([{ type: 'secret.read', terminalId: 't-owner', name: 'stripe-key' }])
    expect(JSON.stringify(audits)).not.toContain('sk_live')
  })

  it('a name nobody sealed exits 2 with the sentence the owner needs, and logs secret.requested', () => {
    const { audits, run } = harness()
    const error = failure(() => run('read', 'stripe-key'))
    expect(error.exitCode).toBe(SECRET_EXIT.missing)
    expect(error.message).toBe('no secret stripe-key — the owner can fill it in the note slot 🔒 stripe-key')
    expect(audits).toEqual([{ type: 'secret.requested', terminalId: 't-owner', name: 'stripe-key' }])
  })

  it('a served session is refused with exit 3 before the store is looked at — whatever the flag says', () => {
    const served = pane({ id: 't-seat', servedSession: { door: 'x' } as never })
    const { store, audits, run } = harness(served)
    store.put('stripe-key', VALUE, { served: true })
    const error = failure(() => run('read', 'stripe-key'))
    expect(error.exitCode).toBe(SECRET_EXIT.refused)
    expect(error.message).toContain("secrets are the owner's")
    expect(error.message).not.toContain(VALUE)
    expect(audits).toEqual([])
    expect(failure(() => run('list')).exitCode).toBe(SECRET_EXIT.refused)
  })

  it('a served pane cannot even reach the socket: no COOKREW_SOCKET, no CLI, not on PATH', () => {
    const env = paneEnv({
      terminalId: 't-seat',
      socketPath: '/tmp/cookrew-runtime/cookrew.sock',
      cliDir: '/app/cli',
      servedEnv: { PATH: '/harness/bin:/usr/bin', HOME: '/sandbox' },
      ownerEnv: { PATH: '/app/cli:/usr/bin', COOKREW_SOCKET: '/tmp/cookrew-runtime/cookrew.sock' }
    })
    expect(env.COOKREW_SOCKET).toBeUndefined()
    expect(env.COOKREW_CLI).toBeUndefined()
    expect(env.PATH).not.toContain('/app/cli')
    expect(Object.values(env).join(' ')).not.toContain('cookrew.sock')
  })

  it('usage mistakes exit 1 and log nothing', () => {
    const { audits, run } = harness()
    expect(failure(() => run('read')).exitCode).toBe(SECRET_EXIT.usage)
    expect(failure(() => run('read', 'Not A Name')).exitCode).toBe(SECRET_EXIT.usage)
    expect(failure(() => run('steal', 'stripe-key')).exitCode).toBe(SECRET_EXIT.usage)
    expect(audits).toEqual([])
  })

  it('list prints names, scope and dates, never values', () => {
    const { store, run } = harness()
    expect(run('list')).toBe('(no secrets sealed)')
    store.put('stripe-key', VALUE)
    const out = run('list')
    expect(out).toContain('stripe-key\tlocal\t')
    expect(out).not.toContain('sk_live')
  })

  it('the socket server lets the exit code through for this error, not only for ask deliveries', () => {
    const src = readFileSync('src/main/socket-server.ts', 'utf8')
    expect(src).toContain("case 'secret':")
    expect(src).toMatch(/exitCode/)
    expect(src).not.toMatch(/\.\.\.\(error instanceof DeliveryError \? \{ exitCode: error\.exitCode \} : \{\}\)/)
  })
})

describe('the audit row the inbox parses', () => {
  it('is the name, then `note:<id>` when a note on that canvas has the slot line', () => {
    const notes = [
      { id: 'n-other', content: '# plain\nno slot' },
      { id: 'n-keys', content: '# Stripe keys\n🔒 stripe-key\n' }
    ]
    expect(secretAuditDetails('stripe-key', notes)).toBe('stripe-key note:n-keys')
    expect(secretAuditDetails('openai-key', notes)).toBe('openai-key')
    expect(secretAuditDetails('stripe-key', [])).toBe('stripe-key')
  })
})
