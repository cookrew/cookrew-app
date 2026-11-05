// A NOTE MADE AS A SECRET (owner 2026-11-05): beside NOTE+ stands 🔒+. It asks
// for a name and makes a note whose whole body is the slot `🔒 <name>`, wired
// to the agent; the value goes straight to the store from the slot's field and
// never touches the note. The open note draws that field: the canvas card that
// used to was retired, so a slot could be made but not filled.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasNode, NoteNodeData } from '../src/shared/model'
import { secretNameFrom } from '../src/shared/secret-slot'
import { makeSecretFor } from '../src/renderer/src/zoom/make-card'
import { SecretSlots } from '../src/renderer/src/nodes/SecretSlot'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')
const agent = { id: 'a1', name: 'Forge' }

function bridge(): { api: Parameters<typeof makeSecretFor>[0]; added: CanvasNode[]; wires: [string, string][] } {
  const added: CanvasNode[] = []
  const wires: [string, string][] = []
  return {
    added,
    wires,
    api: {
      addNode: async (node) => {
        added.push(node)
        return node
      },
      connectNodes: async (a, b) => {
        wires.push([a, b])
      }
    } as unknown as Parameters<typeof makeSecretFor>[0]
  }
}

const note = (over: Partial<NoteNodeData>): NoteNodeData => ({
  kind: 'note',
  id: 'n1',
  name: 'keys',
  customName: null,
  content: '',
  locked: false,
  position: { x: 0, y: 0 },
  size: { width: 280, height: 220 },
  ...over
})

describe('the name an owner types', () => {
  it('becomes one word an agent can type', () => {
    expect(secretNameFrom('DeepSeek API key')).toBe('deepseek-api-key')
    expect(secretNameFrom('  dsv4_key! ')).toBe('dsv4-key')
    expect(secretNameFrom('--a--b--')).toBe('a-b')
    expect(secretNameFrom('x'.repeat(80) + ' y')).toBe('x'.repeat(64))
  })

  it('is refused when nothing of it can be typed', () => {
    for (const bad of ['', '   ', '---', '\u5bc6\u94a5']) expect(secretNameFrom(bad)).toBeNull()
  })
})

describe('making the note', () => {
  it('makes a note that is only the slot, wired to the agent', async () => {
    const b = bridge()
    const made = await makeSecretFor(b.api, 'Dsv4 key', agent, [])
    expect(made).toMatchObject({ ok: true, slot: 'dsv4-key' })
    expect(b.added).toHaveLength(1)
    expect(b.added[0]).toMatchObject({ kind: 'note', name: 'dsv4-key', customName: 'dsv4-key', content: '🔒 dsv4-key\n', locked: false })
    expect(b.wires).toEqual([['a1', b.added[0].id]])
  })

  it('takes a free note name when another card has this one', async () => {
    const b = bridge()
    await makeSecretFor(b.api, 'dsv4', agent, [note({ name: 'dsv4' })])
    expect(b.added[0]).toMatchObject({ name: 'dsv4 2', content: '🔒 dsv4\n' })
  })

  it('gives the agent the note that already holds the slot, rather than a second one', async () => {
    const b = bridge()
    const made = await makeSecretFor(b.api, 'dsv4', agent, [note({ id: 'held', content: '# Secrets\n\n🔒 dsv4\n' })])
    expect(made).toEqual({ ok: true, id: 'held', slot: 'dsv4' })
    expect(b.added).toEqual([])
    expect(b.wires).toEqual([['a1', 'held']])
  })

  it('refuses a name nothing of which can be typed, and says what would do', async () => {
    const b = bridge()
    const made = await makeSecretFor(b.api, '\u5bc6\u94a5', agent, [])
    expect(made).toMatchObject({ ok: false, error: expect.stringMatching(/letters, digits/) })
    expect(b.added).toEqual([])
  })
})

describe('the open note', () => {
  it('draws a field per slot, and no value', () => {
    const html = renderToStaticMarkup(<SecretSlots names={['dsv4', 'github']} rereadOn={false} />)
    expect(html.match(/type="password"/g)).toHaveLength(2)
    expect(html).toContain('data-secret-slot="dsv4"')
    expect(html).toContain('data-secret-slot="github"')
  })

  it('stands in the note view and keeps an edit open on a move into a field', () => {
    const panel = src('AttachPanel.tsx')
    expect(panel).toContain('<SecretSlots')
    expect(panel).toContain("closest('.cr-secret-slots')")
  })
})

describe('the button', () => {
  it('stands beside NOTE+ and BROWSER+, and lands the cursor in the field', () => {
    const arts = src('stage/AgentArtifacts.tsx')
    expect(arts).toContain('<SecretMaker')
    expect(arts).toContain('focusSlot(')
  })
})
