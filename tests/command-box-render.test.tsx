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

const NOW = Date.parse('2026-10-11T10:00:00Z')
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
  alternates: [{ id: 'tinker', name: 'Tinker', reasons: ['idle', 'same repo', 'role: Bugfix'] }],
  reasons: ['idle', 'same repo', 'last touched README · 2h'],
  token: 't1',
  holdMs: 1500,
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
    expect(html).toContain('1.5 s · or ↵ now')
    expect(html).toContain('change ▾')
    expect(html).not.toContain('cmd-rows')
    expect(echoLine({ ...decision, kind: 'recruit', harness: 'Codex', name: 'Prune v1', beside: null, reasons: ['no idle card fits the brief', 'repo-wide → Codex', 'placed on the bench'] } as Decision)).toBe(
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
