/**
 * REMOTE CARD PARITY — the machine-decidable half of
 * docs/briefs/remote-card-parity-contract.md (gate IDs P1–P14 match it; the
 * document is the ledger of record). Browser-only halves are `it.todo`
 * markers pointing at scratchpad/remote-card-gates.mjs so one run prints the
 * whole ledger.
 *
 * Strict: do not weaken a gate to land the card; implement the property.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { callerSub } from '../src/main/caller-identity'
import { DoorTranscript } from '../src/main/door-transcript'
import { HARNESSES, harnessFor } from '../src/main/harness'
import {
  orchLineCommand,
  orchTerminalNode,
  validateFace,
  type ImportFace,
  type ServeTarget
} from '../src/main/import-session'
import { SAFE_SUB } from '../src/main/served-callers'
import { doorNameOf, transcriptSourceFor } from '../src/main/transcript-source'
import { cardAffordances } from '../src/renderer/src/card-affordances'
import { mergeCheckpointRows } from '../src/renderer/src/transcript'
import { doorStateSentence } from '../src/shared/door-transcript-state'
import type { TerminalNodeData } from '../src/shared/model'
import type { TurnRecord } from '../src/shared/turn'

const RELAYED: ServeTarget = {
  origin: 'https://cookrew.dev',
  slug: 'cookrew-alpha',
  door: '@drej/cookrew-alpha'
}
const FACE: ImportFace = {
  name: 'COOKREW Alpha',
  serviceId: 'svc-cookrew-alpha',
  slug: 'cookrew-alpha',
  door: 'Pilot',
  access: 'account',
  version: 1,
  agents: 3,
  paymentRails: []
}
const SCRIPT = '/app/resources/orch-line.mjs'

function remoteNode(over: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    ...orchTerminalNode(FACE, RELAYED, SCRIPT, 'remote-1', '/home/caller', { x: 0, y: 0 }, {
      openedAt: 1
    }),
    ...over
  }
}

const turn = (index: number): TurnRecord => ({
  index,
  prompt: `prompt ${index}`,
  reply: `reply ${index}`,
  startedAt: index,
  endedAt: index + 1
})

describe('P1 placed-and-visible (auto half)', () => {
  it('the plan is one Remote orch terminal with the receipt, single-quoted, no unquoted metacharacter', () => {
    const hostile = { ...FACE, name: 'Team $(touch /tmp/x) `id` "; rm -rf ~; echo "' }
    const node = orchTerminalNode(hostile, RELAYED, SCRIPT, 'n1', '/w', { x: 1, y: 2 }, { openedAt: 5 })
    expect(node.kind).toBe('terminal')
    expect(node.preset).toBe('Remote')
    expect(node.orch).toBe(true)
    expect(node.servedSession).toEqual({
      origin: 'https://cookrew.dev',
      slug: 'cookrew-alpha',
      door: '@drej/cookrew-alpha',
      openedAt: 5
    })
    // argv is single-quoted; between quotes nothing is live. Strip every
    // quoted argument and what is left must be bare `node` and spaces.
    const bare = node.command.replace(/'(?:[^']|'\\'')*'/g, '')
    expect(bare.trim()).toBe('node')
    // A relayed card carries the NAME, never a port (P9 corollary).
    expect(node.command).toContain("'--door' '@drej/cookrew-alpha'")
    expect(node.command).not.toMatch(/127\.0\.0\.1|:\d{4,5}/)
    // A door cannot name itself like a flag and steer the line script.
    expect(validateFace({ ...FACE, name: '--print-sub' })).toBeNull()
  })
  it.todo('P1-live: the placed id is in the DOM, inside the viewport, with pixels or the boot sentence — scratchpad/remote-card-gates.mjs')
})

describe('P2 round-trip', () => {
  it.todo('P2-live: a typed sentinel returns on the same card within 90s and listTurns grows — scratchpad/remote-card-gates.mjs')
})

describe('P3 live-reply', () => {
  it.todo('P3-live: activity flips with the overlay closed; the rail row lands ≤5s after the door has the record — scratchpad/remote-card-gates.mjs')
})

describe('P4 rail-exists', () => {
  it.todo('P4-live: ≥2 turns → .cr-ckpt-* rows == GET /trace/index length; idle preview non-null — scratchpad/remote-card-gates.mjs')
})

describe('P5 rail-behaves', () => {
  it.todo('P5-live: rail-gate-eval F1–F6 GREEN on the remote card, ALIGN_TOLERANCE unchanged — scratchpad/remote-card-gates.mjs')
})

describe('P6 navigation', () => {
  it.todo('P6-live: scrub to T1 shows the door’s T1 title and block, byte-equal — scratchpad/remote-card-gates.mjs')
})

describe('P7 index-identity', () => {
  it('the rows a remote rail draws carry the door’s indices — no second derivation, no offset', async () => {
    // A door history that is NOT contiguous and does NOT start at 1: a capped
    // record, an index the door skipped. Any re-derivation shows here.
    const history = [turn(3), turn(4), turn(7), turn(9)]
    const index = history.map((t) => ({ index: t.index, title: t.prompt, id: `u${t.index}` }))
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/turns') && url.searchParams.has('aroundIndex')) {
        const at = history.findIndex((t) => t.index === Number(url.searchParams.get('aroundIndex')))
        return new Response(JSON.stringify({ turns: [history[at]], total: history.length, offset: at }))
      }
      if (url.pathname.endsWith('/turns')) return new Response(JSON.stringify(history))
      if (url.pathname.endsWith('/trace/index')) return new Response(JSON.stringify(index))
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const door = new DoorTranscript(
      { origin: 'http://127.0.0.1:1', slug: '@drej/cookrew-alpha' },
      { signIn: async () => 'tok', fetcher }
    )
    const listing = await door.traceIndex()
    const rows = mergeCheckpointRows([], listing)
    expect(rows.map((r) => r.index)).toEqual([3, 4, 7, 9])
    expect(rows.map((r) => r.id)).toEqual(['u3', 'u4', 'u7', 'u9'])
    expect(rows).toHaveLength(history.length)
    // And the pager agrees with the rail on identity.
    expect((await door.turns()).map((t) => t.index)).toEqual([3, 4, 7, 9])
    expect((await door.turnsPage({ aroundIndex: 7, limit: 1 })).turns.map((t) => t.index)).toEqual([7])
  })
})

describe('P8 real-record', () => {
  it.todo('P8-live: a 2000-line reply is whole in the transcript and equals GET /trace; the scrape ledger lacks the head — scratchpad/remote-card-gates.mjs')
})

describe('P9 reload', () => {
  it.todo('P9-live: relaunch → rows ≥ R before any prompt, then P2 again — scratchpad/remote-card-gates.mjs --relaunch')
})

describe('P10 refusal-honesty (auto half)', () => {
  it('every refusal is a sentence; the two empty rails are different sentences', () => {
    const slug = 'cookrew-alpha'
    const fresh = doorStateSentence({ kind: 'no-session' }, slug)
    const over = doorStateSentence({ kind: 'ended' }, slug)
    expect(fresh).toMatch(/first prompt opens one/)
    expect(over).toMatch(/has ended/)
    expect(fresh).not.toBe(over)
    for (const kind of ['signed-out', 'not-serving', 'unavailable'] as const) {
      expect(doorStateSentence({ kind }, slug)).toMatch(/\w+ \w+/)
    }
    expect(doorStateSentence({ kind: 'unreachable', status: 500 }, slug)).toMatch(/last good copy/)
    // And a healthy record says nothing extra.
    expect(doorStateSentence({ kind: 'ok', at: 1 }, slug)).toBeNull()
    expect(doorStateSentence(null, slug)).toBeNull()
  })
  it.todo('P10-live: (a) expired token re-signs-in, rail never blanks; (b) unpublished → not-serving copy, no LIVE; (c) ended → ended copy, no LIVE — scratchpad/remote-card-gates.mjs')
})

describe('P11 no-dead-affordance (auto half)', () => {
  it('the menu for a Remote node offers no FORK, SAVE ROLE or WORKDIR; a local node keeps all three', () => {
    const caps = { listTurns: true, roleFromCheckpoint: true }
    expect(cardAffordances(remoteNode(), caps)).toEqual({
      rename: true,
      role: false,
      fork: false,
      workdir: false
    })
    const local: TerminalNodeData = {
      ...remoteNode(),
      preset: 'Claude Code',
      command: 'claude',
      servedSession: null
    }
    expect(cardAffordances(local, caps)).toEqual({ rename: true, role: true, fork: true, workdir: true })
    expect(cardAffordances(null, caps).rename).toBe(false)
  })
  it.todo('P11-live: every interactive element on the remote overlay/card yields an effect or a sentence within 3s — scratchpad/remote-card-gates.mjs')
})

describe('P12 twin-census', () => {
  it.todo('P12-live: serve from this app, import into it, diff the two cards (rows, verdicts, census whitelist) — scratchpad/remote-card-gates.mjs --twin')
})

describe('P13 one-caller', () => {
  const script = path.join(__dirname, '..', 'resources', 'orch-line.mjs')
  const cardSub = (raw: string): string =>
    execFileSync('node', [script, '--print-sub', '--sub', raw], { encoding: 'utf8' }).trim()

  it('the card and the app arrive at a door as the SAME sub, and the door accepts it', () => {
    for (const raw of ['Drej.Smith', 'UPPER', 'a'.repeat(33), '..hidden..', 'x--', 'ünïcode', 'drej', 'a']) {
      const fromCard = cardSub(raw)
      const fromApp = callerSub(raw)
      expect(fromCard, raw).toBe(fromApp)
      expect(SAFE_SUB.test(fromApp), `${raw} → ${fromApp}`).toBe(true)
    }
  })
  it.todo('P13-door: with the card up and the transcript populated, the door’s caller store shows ONE identity and one key file — scratchpad/remote-card-gates.mjs')
})

describe('P14 contract-preserved', () => {
  it("a remote card is a 'door' source, never a harness — the three sources never overlap", () => {
    const remote = remoteNode()
    expect(transcriptSourceFor(remote)).toBe('door')
    expect(harnessFor(remote.command)).toBeNull()
    expect(doorNameOf(remote)).toBe('@drej/cookrew-alpha')
    // A card placed before the receipt carried the name still resolves it
    // from its command — no re-import needed.
    const older = remoteNode({ servedSession: { origin: 'https://cookrew.dev', slug: 'cookrew-alpha', openedAt: 1 } })
    expect(doorNameOf(older)).toBe('@drej/cookrew-alpha')
    // A receipt read back from disk is re-checked before it becomes a path.
    const tampered = remoteNode({ servedSession: { origin: 'https://cookrew.dev', slug: 'x', door: '@drej/../v1/dev', openedAt: 1 } })
    expect(doorNameOf(tampered)).toBe('@drej/cookrew-alpha')
    // A dialled door has no name and reads at its address.
    const dialled = orchTerminalNode(FACE, { origin: 'http://192.168.1.20:8639', slug: 'x' }, SCRIPT, 'd', '/w', { x: 0, y: 0 }, { openedAt: 1 })
    expect(doorNameOf(dialled)).toBeNull()
    expect(transcriptSourceFor(dialled)).toBe('door')
  })

  it("the claude/codex/pi 'file' baseline is untouched, and a scrape shell is still 'scrape'", () => {
    const byId = new Map(HARNESSES.map((h) => [h.id, h]))
    for (const id of ['claude', 'codex', 'pi'] as const) expect(byId.get(id)?.turns).toBe('file')
    const shell: TerminalNodeData = { ...remoteNode(), command: 'bash -l', servedSession: null }
    expect(transcriptSourceFor(shell)).toBe('scrape')
    const claude: TerminalNodeData = { ...remoteNode(), command: 'claude', servedSession: null }
    expect(transcriptSourceFor(claude)).toBe('file')
  })

  it('the relayed command still resolves its port at run time, not from the card', () => {
    expect(orchLineCommand(SCRIPT, RELAYED, 'x')).not.toMatch(/--origin/)
  })
})
