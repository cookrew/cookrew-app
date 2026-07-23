import { describe, expect, it } from 'vitest'
import { recoverEligible, recoverErrorToast, recoverToastFor } from '../src/renderer/src/recover'
import type { RecoverResult } from '../src/shared/model'

const base: RecoverResult = {
  ok: true,
  id: 't-1',
  name: 'Fresco',
  workspaceId: 'ws-1',
  workspaceName: 'cookrew',
  spawned: true,
  legacy: false
}

describe('recoverEligible (agent-recover: which roster rows get the button)', () => {
  it('an INACTIVE registry entry is recoverable (contract: active === false)', () => {
    expect(recoverEligible({ active: false })).toBe(true)
  })
  it('an active entry is not (recover is for killed/dismissed teammates)', () => {
    expect(recoverEligible({ active: true })).toBe(false)
  })
})

describe('recoverToastFor (result → toast copy, verbatim from the landed contract)', () => {
  it('spawned:true → recovered toast', () => {
    expect(recoverToastFor(base)).toEqual({ tone: 'ok', text: 'Recovered Fresco' })
  })
  it('spawned:false → deferred-boot copy naming the inactive workspace', () => {
    expect(recoverToastFor({ ...base, spawned: false })).toEqual({
      tone: 'defer',
      text: 'Recovered Fresco into cookrew — resumes when that workspace opens'
    })
  })
  it('legacy:true → best-effort copy (pre-snapshot kill)', () => {
    expect(recoverToastFor({ ...base, legacy: true })).toEqual({
      tone: 'warn',
      text: 'Recovered Fresco (best-effort — pre-snapshot kill, session may start fresh)'
    })
  })
  it('legacy takes precedence over the defer copy (legacy + deferred boot)', () => {
    // A legacy restore into an inactive workspace: the session-may-start-fresh
    // caveat outranks the defer note — one toast, the stronger warning.
    expect(recoverToastFor({ ...base, legacy: true, spawned: false }).tone).toBe('warn')
  })
  it('ok:false → error toast', () => {
    expect(recoverToastFor({ ...base, ok: false }).tone).toBe('error')
  })
})

describe('recoverErrorToast (thrown/rejected recover → honest error toast)', () => {
  it('carries the backend message', () => {
    expect(recoverErrorToast("No recoverable agent 't-9'")).toEqual({
      tone: 'error',
      text: "Recover failed — No recoverable agent 't-9'"
    })
  })
})
