import { describe, expect, it } from 'vitest'
import { gate, MOCK_SWITCHES, mockToken, nextSwitches, tokenOf } from '../scripts/strata-mock-gate.mjs'

const api = (machineId: string, token: string | null = null) => ({ machineId, api: true, token })

describe('the strata preview mock switches', () => {
  it('serves everything while every switch is off', () => {
    expect(gate(MOCK_SWITCHES, api('syn-studio'))).toBeNull()
    expect(gate(MOCK_SWITCHES, { machineId: 'syn-studio', api: false, token: null })).toBeNull()
  })

  it('wants the machine’s own pairing token on its api while auth is on', () => {
    const on = nextSwitches(MOCK_SWITCHES, { auth: true })
    expect(gate(on, api('syn-studio'))).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    expect(gate(on, api('syn-studio', mockToken('syn-cloud')))).toMatchObject({ status: 401 })
    expect(gate(on, api('syn-studio', mockToken('syn-studio')))).toBeNull()
    expect(gate(on, { machineId: 'syn-studio', api: false, token: null })).toBeNull()
  })

  it('answers a storm with the relay’s own refusal, before any token check', () => {
    const storm = nextSwitches(MOCK_SWITCHES, { auth: true, storm: ['syn-cloud'] })
    expect(gate(storm, api('syn-cloud', mockToken('syn-cloud')))).toMatchObject({ status: 503, body: { error: 'too_many_exchanges' } })
    expect(gate(storm, api('syn-studio', mockToken('syn-studio')))).toBeNull()
  })

  it('holds every request to a hung machine, ahead of a storm', () => {
    const hung = nextSwitches(MOCK_SWITCHES, { storm: ['syn-vm'], hang: ['syn-vm'] })
    expect(gate(hung, api('syn-vm'))).toBe('hang')
    expect(gate(hung, { machineId: 'syn-vm', api: false, token: null })).toBe('hang')
  })

  it('merges a body into new switches and leaves the old ones alone', () => {
    const first = nextSwitches(MOCK_SWITCHES, { storm: ['a', 'a', 'b'] })
    const second = nextSwitches(first, { hang: ['c'] })
    expect(first).toEqual({ auth: false, storm: ['a', 'b'], hang: [] })
    expect(second).toEqual({ auth: false, storm: ['a', 'b'], hang: ['c'] })
    expect(MOCK_SWITCHES).toEqual({ auth: false, storm: [], hang: [] })
    expect(Object.isFrozen(second)).toBe(true)
  })

  it('refuses a malformed body whole', () => {
    expect(() => nextSwitches(MOCK_SWITCHES, null)).toThrow(/JSON object/)
    expect(() => nextSwitches(MOCK_SWITCHES, ['auth'])).toThrow(/JSON object/)
    expect(() => nextSwitches(MOCK_SWITCHES, { offline: ['a'] })).toThrow(/unknown switch: offline/)
    expect(() => nextSwitches(MOCK_SWITCHES, { auth: 'yes' })).toThrow(/true or false/)
    expect(() => nextSwitches(MOCK_SWITCHES, { storm: 'syn-vm' })).toThrow(/list of machine ids/)
    expect(() => nextSwitches(MOCK_SWITCHES, { hang: [''] })).toThrow(/list of machine ids/)
  })

  it('reads the token from a Bearer header first, then from ?token=', () => {
    const url = new URL('http://preview/m/x/api/levels/stream?token=from-query')
    expect(tokenOf({ authorization: 'Bearer from-header' }, url)).toBe('from-header')
    expect(tokenOf({}, url)).toBe('from-query')
    expect(tokenOf({ authorization: 'Basic abc' }, new URL('http://preview/m/x/api/levels'))).toBeNull()
  })

  it('mints mock tokens in the shape of a real pairing token', () => {
    expect(mockToken('syn-studio')).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
  })
})
