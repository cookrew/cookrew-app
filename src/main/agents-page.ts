// THE AGENTS PAGE, MAIN SIDE: the rows (shared/agents-page.ts) from what the
// app already knows — the routing panel's harness scan (installed, signed in,
// in the dock, install and login lines), the dock presets (the launch line),
// and a CACHED `<bin> --version` so the page reads fast and never starts an
// agent. One fresh probe per bin per ten minutes; a bin that is not installed
// is not probed at all.

import { execFile } from 'node:child_process'
import { AGENT_NOTES, MAGPIE_AGENT, orderAgentRows, type AgentPageRow } from '../shared/agents-page'
import { HARNESS_CARDS, HARNESS_IDS, type HarnessId } from '../shared/harness-catalog'
import type { HarnessRow } from '../shared/route'

const VERSION_TTL_MS = 10 * 60 * 1000
const PROBE_TIMEOUT_MS = 4000

export interface AgentPageDeps {
  /** The routing panel's scan (installed, signed in, in the dock, its lines). */
  harnessRow: (id: HarnessId) => Pick<HarnessRow, 'installed' | 'signedIn' | 'inDock' | 'installLine' | 'loginLine'> | null
  /** The dock's launching presets. */
  presets: readonly { name: string; command: string }[]
  /** `<bin> --version`, first line, or null. Defaults to running the bin. */
  version: (bin: string) => Promise<string | null>
}

/** The first version-looking token of a CLI's `--version` output. */
export function versionOf(output: string): string | null {
  const match = /\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/.exec(output)
  return match ? match[0] : null
}

const defaultVersion = (bin: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS, env: process.env }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) return resolve(null)
      resolve(versionOf(String(stdout ?? '')) ?? versionOf(String(stderr ?? '')))
    })
  })

/**
 * A version probe that answers at once after the first look and refreshes
 * only after VERSION_TTL_MS. Concurrent asks for one bin share the run, and a
 * failure is remembered for its TTL too: a bin that hangs on --version must
 * not be run again on every open.
 */
export function agentVersionProbe(probe: (bin: string) => Promise<string | null> = defaultVersion, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; value: string | null }>()
  const running = new Map<string, Promise<string | null>>()
  return async (bin: string): Promise<string | null> => {
    const known = seen.get(bin)
    if (known && now() - known.at < VERSION_TTL_MS) return known.value
    const pending = running.get(bin)
    if (pending) return pending
    const run = probe(bin)
      .then((value) => {
        seen.set(bin, { at: now(), value })
        return value
      })
      .catch(() => {
        seen.set(bin, { at: now(), value: null })
        return null
      })
      .finally(() => running.delete(bin))
    running.set(bin, run)
    return run
  }
}

/** One row per harness the app can run, in catalog order. Not installed: no version probe. */
export async function buildAgentPage(deps: AgentPageDeps): Promise<AgentPageRow[]> {
  const rows = await Promise.all(
    HARNESS_IDS.map(async (id): Promise<AgentPageRow> => {
      const card = HARNESS_CARDS[id]
      const scan = deps.harnessRow(id)
      const preset = deps.presets.find((p) => p.name === card.name)
      const installed = scan?.installed === true
      return {
        id,
        name: card.name,
        bin: card.bin,
        command: preset?.command ?? card.bin,
        installed,
        signedIn: scan?.signedIn ?? null,
        version: installed ? await deps.version(card.bin) : null,
        installLine: scan?.installLine ?? '',
        loginLine: scan?.loginLine ?? null,
        inDock: scan?.inDock ?? preset !== undefined,
        magpieAgent: MAGPIE_AGENT[id],
        note: AGENT_NOTES[id] ?? null
      }
    })
  )
  return orderAgentRows(rows)
}
