// The Agents page: the rows main builds for it (src/main/agents-page.ts) and
// the shape the renderer reads (src/shared/agents-page.ts).

import { describe, expect, it, vi } from 'vitest'
import { AGENT_NOTES, MAGPIE_AGENT } from '../src/shared/agents-page'
import { HARNESS_CARDS, HARNESS_IDS } from '../src/shared/harness-catalog'
import { agentVersionProbe, buildAgentPage, versionOf } from '../src/main/agents-page'

const presets = HARNESS_IDS.map((id) => ({ name: HARNESS_CARDS[id].name, command: `${HARNESS_CARDS[id].bin} --x` }))

describe('the version a CLI printed', () => {
  it('is the first version-looking token', () => {
    expect(versionOf('codex-cli 0.171.0')).toBe('0.171.0')
    expect(versionOf('devin 3000.14.30821 (a09cd7f3)')).toBe('3000.14.30821')
    expect(versionOf('agy 1.5.17\n')).toBe('1.5.17')
    expect(versionOf('no versions here')).toBeNull()
  })
})

describe('the version probe', () => {
  it('asks once, then serves the cache until its TTL; concurrent asks share a run', async () => {
    let at = 1_000
    const ask = vi.fn(async () => '1.2.3')
    const probe = agentVersionProbe(ask, () => at)
    const [a, b] = await Promise.all([probe('x'), probe('x')])
    expect([a, b]).toEqual(['1.2.3', '1.2.3'])
    expect(ask).toHaveBeenCalledTimes(1)
    await probe('x')
    expect(ask).toHaveBeenCalledTimes(1)
    at += 10 * 60 * 1000 + 1
    await probe('x')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('remembers a failure for its TTL too: a bin that hangs is not run on every open', async () => {
    let at = 0
    const ask = vi.fn(async () => null)
    const probe = agentVersionProbe(ask, () => at)
    expect(await probe('x')).toBeNull()
    await probe('x')
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('the rows', () => {
  it('one per harness, in catalog order, with its binary, dock line and Magpie name', async () => {
    const rows = await buildAgentPage({
      harnessRow: (id) => ({ installed: id === 'claude', signedIn: id === 'claude' ? true : null, inDock: id === 'claude', installLine: `install ${id}`, loginLine: `login ${id}` }),
      presets,
      version: async () => '9.9.9'
    })
    expect(rows.map((r) => r.id)).toEqual([...HARNESS_IDS])
    for (const row of rows) {
      expect(row.name).toBe(HARNESS_CARDS[row.id].name)
      expect(row.bin).toBe(HARNESS_CARDS[row.id].bin)
      expect(row.command).toBe(`${HARNESS_CARDS[row.id].bin} --x`)
      expect(row.installLine).toBe(`install ${row.id}`)
      // A signed-in state only means something for what is installed.
      if (!row.installed) expect(row.signedIn).toBeNull()
      expect(row.magpieAgent).toBe(MAGPIE_AGENT[row.id])
      expect(row.note).toBe(AGENT_NOTES[row.id] ?? null)
    }
    expect(rows.find((r) => r.id === 'claude')).toMatchObject({ installed: true, signedIn: true, inDock: true })
  })

  it('a harness that is not installed is not asked for its version', async () => {
    const asked: string[] = []
    const rows = await buildAgentPage({
      harnessRow: (id) => ({ installed: id === 'codex', signedIn: null, inDock: false, installLine: 'x', loginLine: null }),
      presets,
      version: async (bin) => {
        asked.push(bin)
        return '1.0.0'
      }
    })
    expect(asked).toEqual(['codex'])
    expect(rows.find((r) => r.id === 'codex')?.version).toBe('1.0.0')
    expect(rows.filter((r) => r.id !== 'codex').every((r) => r.version === null)).toBe(true)
  })

  it('a bridge that knows nothing still lists every harness (missing, with its dock line)', async () => {
    const rows = await buildAgentPage({ harnessRow: () => null, presets: [], version: async () => '1.0.0' })
    expect(rows).toHaveLength(HARNESS_IDS.length)
    expect(rows.every((r) => !r.installed && r.installLine === '' && r.command === HARNESS_CARDS[r.id].bin)).toBe(true)
  })
})
