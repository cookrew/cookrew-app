// THE WAIT CHOICE BOX, drawn (owner task, 2026-11-04; cut
// docs/avatar-send-tasks/g-choice): the question names a group, each row is a
// button carrying its key, the TUI's cursor row is outlined, the Esc row says
// what it does, a confirm's two keys sit side by side, and a sent row fills.
// Plus the box's timing (answerView) and the placeholder for a free question.
//
// Static markup, the house way (no DOM env).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanTurnLines, tailLines } from '../src/shared/turn'
import { choiceSig, parseWaitChoice, type WaitChoice } from '../src/shared/wait-choice'
import { WaitChoices, footWords, keysWord, rowLabel } from '../src/renderer/src/prompt/WaitChoices'
import { BarWaitCard } from '../src/renderer/src/zoom/BarWaitCard'
import { ANSWER_FAILED, answerView, FILL_MS, keyAction, RETRY_MS, type WaitAnswering, type WaitView } from '../src/renderer/src/prompt/wait-answer'
import { promptPlaceholder } from '../src/renderer/src/prompt/prompt-words'
import type { AgentView } from '../src/renderer/src/zoom/zoom-model'

const fixture = (name: string): WaitChoice => {
  const lines = tailLines(cleanTurnLines(readFileSync(join(__dirname, 'fixtures', 'wait-choice', `${name}.txt`), 'utf8')), 14)
  const choice = parseWaitChoice(lines)
  if (!choice) throw new Error(name)
  return choice
}
const answering = (view: WaitView | null): WaitAnswering => ({ view, menu: view !== null, answer: () => undefined, key: () => false, step: () => undefined, wordsRow: false, sendWords: () => undefined, trayKey: null, failed: null })
const FACE = { id: 't1', name: 'Bar fusion', preset: 'claude', orch: false }
const draw = (view: WaitView | null): string => renderToStaticMarkup(<WaitChoices face={FACE} wait={answering(view)} />)

describe('WaitChoices', () => {
  const edit = fixture('claude-edit')

  it('is a group named by its question, rows before anything else', () => {
    const html = draw({ choice: edit, sent: null })
    const qid = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain('role="group"')
    expect(html).toContain(`id="${qid}">Do you want to make this edit to a.ts?</p>`)
    expect(html).toContain('Bar fusion <b>needs you</b>')
    expect(html).toContain('Edit · a.ts · +1 −1 · the agent waits')
  })

  it('draws one button per option, its key in its name, the cursor row outlined, the Esc row marked', () => {
    const html = draw({ choice: edit, sent: null })
    expect(html.match(/<button/g)?.length).toBe(3)
    expect(html).toContain('aria-label="1: Yes"')
    expect(html).toContain('aria-label="3: No (Esc, then type)"')
    expect(html).toMatch(/class="wc-row cursor"[^>]*aria-label="1: Yes" aria-current="true"/)
    expect(html).toContain('esc · then type')
    expect(html).toContain('tap · or 1–3 · esc cancels')
  })

  it('a confirm: two keys side by side', () => {
    const html = draw({ choice: fixture('ssh-keygen-confirm'), sent: null })
    expect(html).toContain('class="wc-rows yn"')
    expect(html).toContain('aria-label="y: Yes"')
    expect(html).toContain('aria-label="n: No"')
    expect(html).toContain('or y / n')
    expect(html).not.toContain('esc cancels')
  })

  it('sent: the row fills with a tick, the others go dim and every row stands still', () => {
    const html = draw({ choice: edit, sent: 0 })
    expect(html).toContain('class="wc-box answered"')
    expect(html).toMatch(/class="wc-row cursor sent"[^>]*disabled=""/)
    expect(html).not.toContain('aria-pressed')
    expect(html).toContain('✓')
    expect(html.match(/wc-row spent/g)?.length).toBe(2)
    expect(html).toContain('sent 1 · the agent goes on')
  })

  it('nothing to show: nothing drawn', () => {
    expect(draw(null)).toBe('')
  })

  it('a question tool\'s descriptions stand under their labels', () => {
    const html = draw({ choice: fixture('claude-ask'), sent: null })
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`<small id="${described}">A warm, bold color.</small>`)
  })
})

describe('an answer that did not land says why', () => {
  const view = { choice: fixture('claude-edit-cursor-2'), sent: null }
  const failing = (failed: string): string => renderToStaticMarkup(<WaitChoices face={FACE} wait={{ ...answering(view), failed }} />)
  it('a refusal is not told as a menu that moved', () => {
    const html = failing(ANSWER_FAILED.refused)
    expect(html).toContain('did not go through')
    expect(html).not.toContain('moved on')
  })
  it('a menu that moved says so', () => {
    expect(failing(ANSWER_FAILED.moved)).toContain('the menu moved on')
  })
})

describe('BarWaitCard: the same rows in the group\'s card, smaller', () => {
  it('names the agent, says it needs you, and offers the full view and the box', () => {
    const agent = { id: 't1', name: 'Bar fusion', preset: 'claude', orch: false } as AgentView
    const view = { choice: fixture('claude-plan'), sent: null }
    const html = renderToStaticMarkup(<BarWaitCard agent={agent} view={view} wait={answering(view)} onOpen={() => undefined} onReply={() => undefined} onClose={() => undefined} />)
    expect(html).toContain('class="wc-rows small"')
    expect(html).toContain('aria-label="3: Tell Claude what to change (Esc, then type)"')
    expect(html).toContain('needs you')
    expect(html).toContain('full view ↗')
    expect(html).toContain('reply · the box ↓')
  })
})

describe('the words around the rows', () => {
  it('keysWord and rowLabel', () => {
    expect(keysWord(fixture('codex-command'))).toBe('1–3')
    expect(keysWord(fixture('npx-confirm'))).toBe('y / n')
    expect(rowLabel(fixture('codex-command'), 0)).toBe('1: Yes, proceed')
  })

  it('a bare Esc with no Esc row says so', () => {
    expect(footWords({ choice: fixture('claude-ask'), sent: -1 })[0]).toBe('esc sent · the agent goes on')
  })
})

describe('answerView: fill, then shut while the agent takes it, back if it did not', () => {
  const edit = fixture('claude-edit')
  const moved = fixture('claude-edit-cursor-2')
  const sent = { sig: '', index: 0, choice: edit, at: 1000 }
  const answer = { ...sent, sig: choiceSig(edit) }

  it('the sent row fills for FILL_MS, even once the agent has moved on', () => {
    expect(answerView(null, answer, 1000 + FILL_MS - 1)).toEqual({ choice: edit, sent: 0 })
  })

  it('then nothing while the same question is still up (the cursor may move)', () => {
    expect(answerView(moved, answer, 1000 + FILL_MS)).toBe(null)
  })

  it('the same question still up after RETRY_MS: the keys did not take, it is back', () => {
    expect(answerView(moved, answer, 1000 + RETRY_MS)).toEqual({ choice: moved, sent: null })
  })

  it('a new question shows at once', () => {
    const next = fixture('claude-create')
    expect(answerView(next, answer, 1000 + FILL_MS)).toEqual({ choice: next, sent: null })
  })
})

describe('keyAction: what a key in the empty box sends', () => {
  it('a digit is its row; Esc is Esc to a menu', () => {
    const view = { choice: fixture('claude-edit'), sent: null }
    expect(keyAction(view, '2')).toEqual({ index: 1, keys: '2' })
    expect(keyAction(view, 'Escape')).toEqual({ index: 2, keys: '\x1b' })
    expect(keyAction(view, 'x')).toBe(null)
  })

  it('Esc means nothing to a line-reading confirm: never a stray byte in its line (review)', () => {
    const view = { choice: fixture('ssh-keygen-confirm'), sent: null }
    expect(keyAction(view, 'Escape')).toBe(null)
    expect(keyAction(view, 'y')).toEqual({ index: 0, keys: 'y\r' })
    expect(keyAction(view, 'N')).toBe(null)
  })

  it('nothing while a row is filling', () => {
    expect(keyAction({ choice: fixture('claude-edit'), sent: 0 }, '2')).toBe(null)
  })
})

describe('a free question: no box, the placeholder asks for the answer', () => {
  it('"Answer <name>…", unless asleep', () => {
    const agent = { name: 'Velvet', status: 'waiting' }
    expect(promptPlaceholder({ agent, stop: 'crew', workspace: null, item: null, asks: true })).toBe('Answer Velvet…')
    expect(promptPlaceholder({ agent, stop: 'crew', workspace: null, item: null })).toBe('Reply to Velvet…')
    expect(promptPlaceholder({ agent: { name: 'Velvet', status: 'offline' }, stop: 'crew', workspace: null, item: null, asks: true })).toBe('Velvet is asleep · wakes on send')
  })
})
