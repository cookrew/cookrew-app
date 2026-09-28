import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { heldLine, heldState, shelvesOf, yoursLine } from '../src/renderer/src/import-shelves'
import type { TeamMeta } from '../src/shared/model'
import type { HeldSeatRow } from '../src/shared/seats'

/**
 * THE IMPORT SHEET'S TWO SHELVES (owner request, 2026-09-28: importing a
 * team must offer the agents saved locally, visible only to their owner, and
 * the agents of others this account has bought a seat for).
 *
 * The saved teams on this machine and the seats this account holds are the
 * two things a person can place without an address in hand, so the sheet
 * lists them under the field. These tests lock the rules the sheet only
 * draws: newest first, private stated on every saved row, an ended or expired
 * seat listed but not placeable, and the sheet wired to both reads.
 */

const NOW = Date.parse('2026-09-28T10:00:00Z')

const team = (name: string, savedAt: number, terminals = 3, nodes = 7): TeamMeta => ({
  name,
  savedAt,
  nodeCount: nodes,
  terminalCount: terminals
})

const seat = (patch: Partial<HeldSeatRow['seat']> = {}): HeldSeatRow => ({
  seat: {
    id: 'seat-1',
    team: '@drej/cookrew-alpha',
    account: 'mira',
    source: 'bought',
    createdAt: NOW - 3 * 86_400_000,
    ...patch
  },
  url: 'https://cookrew.dev/@drej/cookrew-alpha'
})

describe('import shelves — what can be placed without an address', () => {
  it('orders both shelves newest first, and tolerates a missing seats surface', () => {
    const shelves = shelvesOf([team('Old', 1), team('New', 2)], null)
    expect(shelves.yours.map((t) => t.name)).toEqual(['New', 'Old'])
    expect(shelves.held).toEqual([])
  })

  it('every saved row says it is private, and counts what it holds', () => {
    expect(yoursLine(team('Core', 1, 1, 1))).toBe('1 agent · 1 card · saved here, only you see it')
    expect(yoursLine(team('Core', 1))).toBe('3 agents · 7 cards · saved here, only you see it')
  })

  it('a held seat states how it was obtained, and stops being placeable when ended or expired', () => {
    expect(heldState(seat(), NOW)).toBe('open')
    expect(heldLine(seat(), NOW)).toBe('bought')
    expect(heldLine(seat({ source: 'granted', by: 'drej' }), NOW)).toBe('granted by @drej')
    expect(heldState(seat({ endedAt: NOW - 1 }), NOW)).toBe('ended')
    expect(heldLine(seat({ endedAt: NOW - 1 }), NOW)).toBe('bought · ended by the owner')
    expect(heldState(seat({ expiresAt: NOW - 1 }), NOW)).toBe('expired')
    expect(heldState(seat({ expiresAt: NOW + 1 }), NOW)).toBe('open')
  })

  it('the sheet reads both shelves and places them the way the dock and the gate do', () => {
    const sheet = readFileSync(path.join(__dirname, '..', 'src/renderer/src/ImportServedSheet.tsx'), 'utf8')
    // a saved team becomes a session workspace — the dock's own verb, not a second copy of it
    expect(sheet).toContain('teamList?.()')
    expect(sheet).toContain('.templateImport(team.name)')
    // a held seat re-enters the address flow by its own name; the gate's seat rung does the rest
    expect(sheet).toContain('accountSeats?.()')
    expect(sheet).toContain('link: row.seat.team')
    // an ended seat is listed, not placeable
    expect(sheet).toContain("heldState(row) !== 'open'")
    // the field is still first and still the way in for a team never seen
    expect(sheet.indexOf('className="gs-input"')).toBeLessThan(sheet.indexOf('className="isv-shelf"'))
  })
})
