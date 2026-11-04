// F7 (Menu QA, 2026-11-04): from a full view, a waiting agent's face in the
// troop floated a plain card, NEEDS YOU and no rows, so its menu could not be
// answered there.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseWaitChoice } from '../src/shared/wait-choice'
import { cleanTurnLines } from '../src/shared/turn'
import type { WaitAnswering, WaitView } from '../src/renderer/src/prompt/wait-answer'
import type { AgentView } from '../src/renderer/src/zoom/zoom-model'

const seen = vi.hoisted(() => ({ view: null as unknown, onType: null as unknown }))
vi.mock('../src/renderer/src/prompt/wait-answer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/prompt/wait-answer')>()),
  useWaitAnswer: (_id: string, onType: () => void): Partial<WaitAnswering> => {
    seen.onType = onType
    return { view: seen.view as WaitView | null, menu: seen.view !== null, answer: () => undefined, key: () => false, step: () => undefined, wordsRow: false, sendWords: () => undefined, trayKey: null, failed: null }
  }
}))

const { AgentPetCard } = await import('../src/renderer/src/pets/AgentPetCard')

const agent = { id: 'a1', name: 'Dilan', preset: 'claude', orch: false, status: 'waiting', word: 'needs you', browsers: 0, notes: 0, turn: null } as unknown as AgentView
const choice = parseWaitChoice(cleanTurnLines(readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-edit-cursor-2.txt'), 'utf8')))
const open = (): void => undefined
const draw = (): string =>
  renderToStaticMarkup(<AgentPetCard agent={agent} items={[]} onOpen={open} onItem={() => undefined} onDraft={() => undefined} onClose={() => undefined} />)

describe("a troop face's card", () => {
  it('waiting on a menu: the rows, and no remove mark one tap from losing the question', () => {
    seen.view = { choice, sent: null }
    const html = draw()
    expect(html).toContain('wc-row')
    expect(html).not.toContain('zv-del')
  })
  it('the row to type in opens the agent: the box in sight is someone else\'s', () => {
    seen.view = { choice, sent: null }
    draw()
    expect(seen.onType).toBe(open)
  })
  it('no menu: the agent\'s own card', () => {
    seen.view = null
    expect(draw()).toContain('ag-plate')
  })
})
