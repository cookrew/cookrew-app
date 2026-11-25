import { describe, expect, it } from 'vitest'
import {
  GUEST_AT_WORKSPACES,
  guestEntry,
  guestEntryOf,
  guestMachineOf,
  guestThemeOf,
  machineGuestUrl,
  parseGuestBoot,
  parseGuestCommand,
  parseGuestReport
} from '../src/shared/machine-guest'

/**
 * ANOTHER MACHINE IN THIS DESKTOP'S WINDOW, AS THE CONSOLE DRAWS IT (owner
 * 2026-11-25): the guest's address, and the two small messages between it and
 * the window that holds it, each checked on arrival.
 */

const SOLIS = '0f8c7b1e-1234-4abc-9def-0123456789ab'

describe('the guest’s address', () => {
  it('one origin per machine, opened where it was asked', () => {
    expect(machineGuestUrl(SOLIS)).toBe(`cookrew-machine://${SOLIS}/`)
    expect(machineGuestUrl(SOLIS, { workspace: 'w-1', agent: null, item: null, side: 'agents' })).toBe(`cookrew-machine://${SOLIS}/?w=w-1`)
    expect(machineGuestUrl(SOLIS, { workspace: 'w-1', agent: 't-1', item: null, side: 'agents' })).toBe(`cookrew-machine://${SOLIS}/?w=w-1&a=t-1`)
    expect(machineGuestUrl(SOLIS, { workspace: 'w-1', agent: null, item: null, side: 'items' })).toBe(`cookrew-machine://${SOLIS}/?w=w-1&side=items`)
    expect(machineGuestUrl(SOLIS, { workspace: 'w-1', agent: null, item: 'b-1', side: 'items' })).toBe(`cookrew-machine://${SOLIS}/?w=w-1&i=b-1`)
    expect(machineGuestUrl(SOLIS, GUEST_AT_WORKSPACES, 'root')).toBe(`cookrew-machine://${SOLIS}/?theme=root`)
  })

  it('is for a machine only: anything else has none', () => {
    expect(machineGuestUrl('not-a-machine')).toBeNull()
    expect(machineGuestUrl('../etc')).toBeNull()
    // The id as the registry keeps it.
    expect(machineGuestUrl(SOLIS.toUpperCase())).toBe(`cookrew-machine://${SOLIS}/`)
  })

  it('reads back what it was opened with, and only what holds together', () => {
    expect(guestEntryOf('?w=w-1&a=t-1')).toEqual({ workspace: 'w-1', agent: 't-1', item: null, side: 'agents' })
    expect(guestEntryOf('?w=w-1&side=items')).toEqual({ workspace: 'w-1', agent: null, item: null, side: 'items' })
    expect(guestEntryOf('?w=w-1&i=n-1')).toEqual({ workspace: 'w-1', agent: null, item: 'n-1', side: 'items' })
    // No agent or artifact without its workspace; no id that is not plain.
    expect(guestEntryOf('?a=t-1')).toEqual(GUEST_AT_WORKSPACES)
    expect(guestEntryOf('?w=../x&a=t-1')).toEqual(GUEST_AT_WORKSPACES)
    // An agent's full view, not an artifact's, when both were asked.
    expect(guestEntry({ workspace: 'w', agent: 'a', item: 'i' })).toEqual({ workspace: 'w', agent: 'a', item: null, side: 'agents' })
    expect(guestThemeOf('?theme=root')).toBe('root')
    expect(guestThemeOf('?theme=<script>')).toBeNull()
  })

  it('names its machine by its host, and nothing else', () => {
    expect(guestMachineOf(`cookrew-machine://${SOLIS}/?w=w-1`)).toBe(SOLIS)
    expect(guestMachineOf(`cookrew-machine://${SOLIS}`)).toBe(SOLIS)
    expect(guestMachineOf(`https://${SOLIS}/`)).toBeNull()
    expect(guestMachineOf('cookrew-machine://evil.example/')).toBeNull()
    expect(guestMachineOf(`cookrew-machine://${SOLIS}.evil.example/`)).toBeNull()
  })
})

describe('what the guest says, and what it is asked', () => {
  it('a route is names, cut to a line; a leave is one of four reasons', () => {
    expect(parseGuestReport({ kind: 'route', workspace: ' Box Lab ', agent: 'Solis Codex' })).toEqual({ kind: 'route', workspace: 'Box Lab', agent: 'Solis Codex' })
    expect(parseGuestReport({ kind: 'route', workspace: '', agent: 7 })).toEqual({ kind: 'route', workspace: null, agent: null })
    expect((parseGuestReport({ kind: 'route', workspace: 'x'.repeat(500), agent: null }) as { workspace: string }).workspace).toHaveLength(120)
    for (const why of ['devices', 'no-key', 'key-refused', 'signed-out']) expect(parseGuestReport({ kind: 'leave', why })).toEqual({ kind: 'leave', why })
    expect(parseGuestReport({ kind: 'leave', why: 'quit' })).toBeNull()
    expect(parseGuestReport({ kind: 'eval', code: '1' })).toBeNull()
    expect(parseGuestReport(null)).toBeNull()
  })

  it('a command is one of the title line’s steps, and nothing else', () => {
    for (const kind of ['device', 'workspace', 'back']) expect(parseGuestCommand({ kind, extra: 1 })).toEqual({ kind })
    expect(parseGuestCommand({ kind: 'navigate', url: 'https://x' })).toBeNull()
    expect(parseGuestCommand('back')).toBeNull()
  })

  it('the boot line names a machine, and a key or none', () => {
    expect(parseGuestBoot({ machine: SOLIS, key: 'k'.repeat(32) })).toEqual({ machine: SOLIS, key: 'k'.repeat(32) })
    expect(parseGuestBoot({ machine: SOLIS, key: null })).toEqual({ machine: SOLIS, key: null })
    expect(parseGuestBoot({ machine: SOLIS, key: '' })).toEqual({ machine: SOLIS, key: null })
    expect(parseGuestBoot({ machine: 'x', key: 'k' })).toBeNull()
    expect(parseGuestBoot(undefined)).toBeNull()
  })
})
