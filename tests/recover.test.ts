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
  legacy: false,
  exact: true
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
  it('!exact → honest "couldn\'t restore exact session" warn (EXACT-CONTEXT gate)', () => {
    expect(recoverToastFor({ ...base, exact: false, spawned: false })).toEqual({
      tone: 'warn',
      text: "Recovered Fresco's position, but its exact session couldn't be located — not resumed"
    })
  })
  it('!exact outranks defer/legacy (never a false success)', () => {
    expect(recoverToastFor({ ...base, exact: false, legacy: true, spawned: false }).tone).toBe('warn')
  })
  it('legacy with exact restore is a clean recovery (no false caveat)', () => {
    expect(recoverToastFor({ ...base, legacy: true }).tone).toBe('ok')
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
