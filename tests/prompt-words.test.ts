// THE PROMPT'S WORDS & STATES (owner design, 2026-11-04 · task "Prompt words &
// states"): the placeholder says who the words go to, per view; an item's
// full view nobody has used attaches the item as a removable #ref chip that
// rides the send; a remote agent wears a small ↗ on the chip and the face.
import { describe, expect, it } from 'vitest'
import { artifactRefs, expandRefs, type PromptArtifact } from '../src/renderer/src/prompt/artifact-refs'
import { promptPlaceholder, withItemRef, wordsStop } from '../src/renderer/src/prompt/prompt-words'

describe('which stop the words are read at', () => {
  it('the bar names the stops: devices, workspaces, the crew, the artifacts', () => {
    expect(wordsStop({ dir: 'agents', v: -2, full: null })).toBe('devices')
    expect(wordsStop({ dir: 'agents', v: -1, full: null })).toBe('workspaces')
    expect(wordsStop({ dir: 'agents', v: 1, full: null })).toBe('crew')
    expect(wordsStop({ dir: 'items', v: -2, full: null })).toBe('devices')
    expect(wordsStop({ dir: 'items', v: -1, full: null })).toBe('workspaces')
    expect(wordsStop({ dir: 'items', v: 0, full: null })).toBe('artifacts')
  })

  it('in between, the nearest stop; past the crew (a card), still the crew', () => {
    expect(wordsStop({ dir: 'agents', v: -1.6, full: null })).toBe('devices')
    expect(wordsStop({ dir: 'agents', v: 2, full: null })).toBe('crew')
  })

  it("a browser's or a note's full view is the item's", () => {
    expect(wordsStop({ dir: 'items', v: 1, full: 'item' })).toBe('item')
  })
})

describe('the placeholder says who the words go to', () => {
  const base = { workspace: 'Cookrew Dev', item: null }
  it('an agent: Reply to its name', () => {
    expect(promptPlaceholder({ ...base, agent: { name: 'Conductor', status: 'idle' }, stop: 'crew' })).toBe('Reply to Conductor…')
    expect(promptPlaceholder({ ...base, agent: { name: 'Rename Anyone', status: 'working' }, stop: 'item' })).toBe('Reply to Rename Anyone…')
  })

  it('an agent asleep: it wakes on send', () => {
    expect(promptPlaceholder({ ...base, agent: { name: 'Lark', status: 'offline' }, stop: 'crew' })).toBe('Lark is asleep · wakes on send')
  })

  it('nobody at the devices and workspaces stops: a new agent in the active workspace', () => {
    expect(promptPlaceholder({ ...base, agent: null, stop: 'devices' })).toBe('New agent in Cookrew Dev…')
    expect(promptPlaceholder({ ...base, agent: null, stop: 'workspaces' })).toBe('New agent in Cookrew Dev…')
  })

  it('nobody at the crew: describe a task for a new agent', () => {
    expect(promptPlaceholder({ ...base, agent: null, stop: 'crew' })).toBe('Describe a task for a new agent…')
  })

  it('nobody at the artifacts: # adds a note or browser', () => {
    expect(promptPlaceholder({ ...base, agent: null, stop: 'artifacts' })).toBe('New agent… · # adds a note or browser')
  })

  it("nobody in an item's full view: a new agent with the item", () => {
    expect(promptPlaceholder({ ...base, agent: null, stop: 'item', item: { name: 'Route plan' } })).toBe('New agent with #Route plan…')
  })

  it('the item let go of, or no workspace name yet: the crew\'s words', () => {
    expect(promptPlaceholder({ ...base, agent: null, stop: 'item' })).toBe('Describe a task for a new agent…')
    expect(promptPlaceholder({ agent: null, stop: 'devices', workspace: null, item: null })).toBe('Describe a task for a new agent…')
    expect(promptPlaceholder({ agent: null, stop: 'workspaces', workspace: '  ', item: null })).toBe('Describe a task for a new agent…')
  })
})

describe('the attached item rides the send as #Name', () => {
  const plan: PromptArtifact = { id: 'b1', name: 'Route plan', kind: 'browser', owners: [] }

  it('ahead of the words, so artifact-refs reads it and wires it', () => {
    const sent = withItemRef('sum it up', plan, [plan])
    expect(sent).toBe('#Route plan: sum it up')
    const refs = artifactRefs(sent, [plan])
    expect(refs.map((r) => r.artifact.id)).toEqual(['b1'])
    expect(expandRefs(sent, refs)).toBe('the browser "Route plan": sum it up')
  })

  it('once: words that name it already are left as they are', () => {
    expect(withItemRef('read #route plan first', plan, [plan])).toBe('read #route plan first')
  })

  it('no item, or no words: the words untouched', () => {
    expect(withItemRef('hello', null, [plan])).toBe('hello')
    expect(withItemRef('  ', plan, [plan])).toBe('  ')
  })
})

const drawPrompt = async (props: Record<string, unknown>): Promise<string> => {
  const store = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  g.window = g.window ?? globalThis
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
  return renderToStaticMarkup(createElement(GlobalPrompt, { harnesses: ['Claude Code'], nodes: [], ...props } as never))
}

describe('a remote agent wears ↗ (it runs elsewhere)', () => {
  it('on the chip, and attaching stays refused', async () => {
    const html = await drawPrompt({ fullAgentId: 'r', agents: [{ id: 'r', name: 'Rook', remote: true }] })
    expect(html).toMatch(/class="pf-chip-face"[^]*?class="pf-remote"[^>]*>↗</)
    expect(html).toContain('runs elsewhere')
  }, 20_000)

  it('a local agent wears none', async () => {
    const html = await drawPrompt({ fullAgentId: 'l', agents: [{ id: 'l', name: 'Lark', remote: false }] })
    expect(html).not.toContain('pf-remote')
  })

  it('on the folded face', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { PromptFace } = await import('../src/renderer/src/prompt/PromptFace')
    const agent = { id: 'r', name: 'Rook', preset: 'Claude Code', orch: false, status: 'idle' as const }
    const face = (remote: boolean): string =>
      renderToStaticMarkup(createElement(PromptFace, { agent, harness: 'Claude Code', mode: 'folded', remote, label: 'Reply to Rook', onTap: () => undefined }))
    expect(face(true)).toMatch(/class="pf-remote"[^>]*>↗</)
    expect(face(true)).toContain('pf-is-remote')
    expect(face(false)).not.toContain('pf-remote')
  })
})

describe('the box says who, drawn', () => {
  it('an agent in its full view: Reply to its name', async () => {
    const html = await drawPrompt({ fullAgentId: 'l', agents: [{ id: 'l', name: 'Lark', remote: false }] })
    expect(html).toContain('placeholder="Reply to Lark…"')
  })

  it('nobody: a new agent, the workspace named where the stop is outside it', async () => {
    const html = await drawPrompt({ fullAgentId: null, agents: [], workspaceName: 'Cookrew Dev' })
    // The server's snapshot of the zoom is the crew.
    expect(html).toContain('placeholder="Describe a task for a new agent…"')
  })
})

describe('the attached item, a removable #ref chip', () => {
  it('says #Name and lets go with ×', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { ItemRefChip } = await import('../src/renderer/src/prompt/ItemRefChip')
    const html = renderToStaticMarkup(createElement(ItemRefChip, { item: { id: 'b1', name: 'Route plan', kind: 'browser', owners: [] }, onRemove: () => undefined }))
    expect(html).toContain('cr-prompt-ref')
    expect(html).toContain('#Route plan')
    expect(html).toMatch(/aria-label="Leave Route plan out"/)
  })
})

describe("the chip's name has room at 360 px", () => {
  it('the phone gives the chip more than a third of the row, the × still a thumb', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(__dirname, '../src/renderer/src/prompt/global-prompt.css'), 'utf8')
    const phone = css.slice(css.lastIndexOf('@media (max-width: 700px)'))
    const cap = phone.match(/body \.cr-prompt-to,\n\s*body \.cr-prompt \.cr-prompt-new:has\(> \.cr-prompt-harness\) \{[^}]*max-width: (\d+)%;/)
    expect(Number(cap?.[1])).toBeGreaterThanOrEqual(44)
  })
})
