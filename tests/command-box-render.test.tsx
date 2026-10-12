// THE ONE BOX RENDERS (route program R3): the inbox rows above the field, the
// decision echo under it, and the phone variant — as static markup, the house
// way (no jsdom; renderToStaticMarkup over a stubbed window, vi.resetModules
// and a dynamic import because api.ts reads module-scope globals once).

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InboxRow } from '../src/shared/inbox-rank'
import type { Decision } from '../src/main/sous-control'

const stubDesktop = (): void => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

// the wait is rendered from `since` against the clock, so the rows are relative to now
const NOW = Date.now()
const rows: InboxRow[] = [
  {
    nodeId: 'forge',
    nodeName: 'Forge',
    nodeKind: 'terminal',
    workspaceId: 'ws',
    workspaceName: 'Cookrew Dev',
    kind: 'waiting',
    kinds: ['waiting'],
    reasons: ['asks you — "replace the Chinese headings too?"'],
    since: NOW - 4 * 60_000,
    waitMinutes: 4,
    served: false,
    blockedDownstream: 2,
    score: 3 * Math.log1p(4)
  },
  {
    nodeId: 'note-1',
    nodeName: 'Tinker',
    nodeKind: 'note',
    workspaceId: 'ws',
    workspaceName: 'Cookrew Dev',
    kind: 'secret',
    kinds: ['secret'],
    reasons: ['needs STRIPE_SECRET_KEY — seal it'],
    since: NOW - 60_000,
    waitMinutes: 1,
    served: true,
    blockedDownstream: 1,
    score: 2 * 2 * Math.log1p(1),
    slot: 'STRIPE_SECRET_KEY',
    noteId: 'note-1'
  }
]
const decision: Decision = {
  kind: 'ask',
  target: { id: 'forge', name: 'Forge' },
  alternates: [
    { kind: 'ask', id: 'tinker', name: 'Tinker', reasons: ['idle', 'same repo', 'role: Bugfix'] },
    { kind: 'recruit', id: 'harness:Claude Code', name: 'Claude Code', harness: 'Claude Code', reasons: ['a brief with no shape → Claude Code'] }
  ],
  recruit: { harness: 'Claude Code', name: 'Install Section', beside: null, direct: true },
  reasons: ['idle', 'same repo', 'last touched README · 2h'],
  token: 't1',
  holdMs: 2500,
  sentence: 'Make the install section of README English'
}

async function box(): Promise<typeof import('../src/renderer/src/CommandBox')> {
  stubDesktop()
  vi.resetModules()
  return import('../src/renderer/src/CommandBox')
}

describe('CommandBox — one surface: the inbox rows, the field, the echo', () => {
  it('draws the rows above the field: card · reason · waited · what it blocks, the strongest kind on each', async () => {
    const { CommandBox } = await box()
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={rows} />)
    expect(html).toContain('class="cmd"')
    expect(html.indexOf('cmd-rows')).toBeLessThan(html.indexOf('cmd-field'))
    expect(html).toContain('data-kind="waiting"')
    // static markup escapes the quotes in the agent's question
    expect(html).toContain('<b>Forge</b><span>asks you — &quot;replace the Chinese headings too?&quot;</span>')
    expect(html).toContain('>4 m<')
    expect(html).toContain('>blocks 2<')
    // the secret row lands on the note, says who asked, and is marked as a paid seat
    expect(html).toContain('data-kind="secret"')
    expect(html).toContain('<b>Tinker</b><span>needs STRIPE_SECRET_KEY — seal it</span>')
    expect(html).toContain('cmd-row served')
    // one field, one key hint, no second button
    expect(html.match(/<input/g)).toHaveLength(1)
    expect(html).toContain('placeholder="Tell the crew what to do…"')
  })

  it('shows the decision as the line under the box — who, three reasons, the hold, and the way to change it', async () => {
    const { CommandBox, echoLine } = await box()
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialDecision={decision} />)
    expect(html).toContain('data-decision="ask"')
    expect(html).toContain('→ Forge (idle · same repo · last touched README · 2h)')
    expect(html).toContain('auto in 2.5 s · or ↵ now')
    expect(html).toContain('change ▾')
    expect(html).not.toContain('cmd-rows')
    expect(echoLine({ ...decision, kind: 'recruit', harness: 'Codex', name: 'Prune v1', beside: null, direct: false, reasons: ['no idle card fits the brief', 'repo-wide → Codex', 'placed on the bench'] } as Decision)).toBe(
      '+ Codex card · Prune v1 (no idle card fits the brief · repo-wide → Codex · placed on the bench)'
    )
  })

  it('a question is the echo itself, with nothing to hold or change', async () => {
    const { CommandBox } = await box()
    const html = renderToStaticMarkup(
      <CommandBox open onClose={() => undefined} phone={false} rows={[]} initialDecision={{ kind: 'question', question: 'Is that a task for the crew, or a question for me?', reasons: ['a question, not a brief'], token: 'q', holdMs: 1500, sentence: 'next week' }} />
    )
    expect(html).toContain('data-decision="question"')
    expect(html).toContain('Is that a task for the crew, or a question for me?')
    expect(html).not.toContain('or ↵ now')
    expect(html).not.toContain('change ▾')
  })

  it('what Sous said is shown as main said it — the recruit line ends in "sent" / "已派出" only because main put it there — and fades after 3.5 s', async () => {
    const { CommandBox, SAID_FADE_MS } = await box()
    // Main's copy (sous-control RECRUITED), said only once the brief reached the new card.
    for (const said of ['New Claude Code card · Write Haiku About · sent', '新建了 Claude Code 卡「写俳句」，已派出']) {
      const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialSaid={said} />)
      expect(html).toContain('class="cmd-echo said"')
      expect(html).toContain(`<span class="line">${said}</span>`)
    }
    // The box adds no "sent" of its own: the word is in the line exactly as often as main wrote it.
    const once = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialSaid="Sent to Forge" />)
    expect(once.match(/sent/gi)).toHaveLength(1)
    expect(SAID_FADE_MS).toBe(3500)
  })

  it('the phone is the same box as the bottom bar, three rows at most, and it never closes', async () => {
    const { CommandBox } = await box()
    const many = [0, 1, 2, 3, 4].map((i) => ({ ...rows[0], nodeId: `n${i}`, nodeName: `Card ${i}` }))
    const html = renderToStaticMarkup(<CommandBox open={false} onClose={() => undefined} phone rows={many} />)
    expect(html).toContain('class="cmd phone"')
    expect(html.match(/data-kind="/g)).toHaveLength(3)
    // closed on the desktop renders nothing at all
    expect(renderToStaticMarkup(<CommandBox open={false} onClose={() => undefined} phone={false} rows={rows} />)).toBe('')
  })
})

describe('round 2 — the change list names the other path, and a direct recruit says so', () => {
  it('"+ new Claude Code card" for the recruit alternate, "→ Tinker instead" for a card', async () => {
    const { altLabel, echoLine } = await box()
    expect(altLabel({ kind: 'recruit', id: 'harness:Claude Code', name: 'Claude Code', harness: 'Claude Code', reasons: [] })).toBe('+ new Claude Code card')
    expect(altLabel({ kind: 'ask', id: 'tinker', name: 'Tinker', reasons: [] })).toBe('→ Tinker instead')
    expect(echoLine({ ...decision, kind: 'recruit', harness: 'Pi', name: 'Draft Limerick', beside: null, direct: true, reasons: ['no idle card fits the brief', 'light · cheap · local → Pi', 'placed on the bench'] } as Decision)).toBe(
      '+ Pi card · Draft Limerick (no idle card fits the brief · light · cheap · local → Pi · placed on the bench) · will run direct'
    )
  })
})
